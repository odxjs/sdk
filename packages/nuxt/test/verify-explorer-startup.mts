import type { Browser, Page } from 'playwright-core'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { getExplorerSourceHash, getWorkspaceLockHash, listClientFiles } from '../../explorer/scripts/client-contract.mjs'
import { createExplorerBrowserBackend } from '../../explorer/test/browser-backend'
import { createExplorerClientMiddleware } from '../src/devtools-client'

const RE_SCRIPT = /\.m?js$/
const RE_STYLE = /\.css$/
const base = '/__odx__/client/'

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const client = resolve(root, 'packages/explorer/dist/client')
  const output = resolve(process.argv[2] || resolve(root, '.artifacts/explorer-startup'))
  await mkdir(output, { recursive: true })
  const startedAt = new Date().toISOString()
  const workspaceSourceHash = await getExplorerSourceHash(resolve(root, 'packages/explorer'))
  const lockfileHash = await getWorkspaceLockHash(resolve(root, 'packages/explorer'))
  const manifest = JSON.parse(await readFile(resolve(client, 'manifest.json'), 'utf8'))
  const runnerSource = await readFile(fileURLToPath(import.meta.url))
  const runnerHash = createHash('sha256').update(runnerSource).digest('hex')
  await writeFile(resolve(output, 'runner.mts'), runnerSource)
  const recordBuiltBaseline = process.argv.includes('--record-built-baseline')
  if (!recordBuiltBaseline)
    assert.equal(manifest.sourceHash, workspaceSourceHash, 'Build the current static Explorer first.')
  assert.equal(manifest.lockfileHash, lockfileHash, 'Static client lockfile is stale.')
  async function verifyBuiltFiles(): Promise<void> {
    const files = await listClientFiles(client)
    delete files['manifest.json']
    assert.deepEqual(files, manifest.files, 'Static client files changed or do not match their manifest.')
  }
  await verifyBuiltFiles()
  await writeFile(resolve(output, 'client-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const middleware = await createExplorerClientMiddleware(client, { baseURL: base, apiBase: '' })
  const server = createServer((request, response) => {
    if (!request.url?.startsWith(base)) {
      response.writeHead(404).end()
      return
    }
    request.url = `/${request.url.slice(base.length)}`
    middleware(request, response, (error) => {
      response.writeHead(error ? 500 : 404).end()
    })
  })
  let browser: Browser | undefined
  let backend: Awaited<ReturnType<typeof createExplorerBrowserBackend>> | undefined
  const samples: unknown[] = []
  let failure: string | undefined
  let browserVersion: string | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    backend = await createExplorerBrowserBackend()
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
    browserVersion = browser.version()
    for (let sample = 0; sample < 3; sample++) {
      await backend.reset()
      const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'en-US' })
      const page = await context.newPage()
      const errors: string[] = []
      const assets: { url: string, bytes: number, kind: string }[] = []
      const pending: Promise<void>[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => message.type() === 'error' && errors.push(message.text()))
      page.on('response', (response) => {
        const target = new URL(response.url())
        const kind = RE_SCRIPT.test(target.pathname) ? 'js' : RE_STYLE.test(target.pathname) ? 'css' : undefined
        if (kind && target.origin === origin) {
          pending.push(response.body().then((body) => {
            assert(response.ok(), `Asset HTTP ${response.status()}: ${target.pathname}`)
            assets.push({ url: target.pathname, bytes: body.byteLength, kind })
          }).catch((error) => {
            errors.push(error instanceof Error ? error.message : String(error))
          }))
        }
      })
      await page.route('**/*', async (route) => {
        const target = new URL(route.request().url())
        if ((target.pathname.startsWith('/__odx__/') && !target.pathname.startsWith(base)) || target.pathname.startsWith('/api/odx/')) {
          const response = await route.fetch({ url: `${backend!.origin}${target.pathname}${target.search}` })
          await route.fulfill({ response })
        }
        else {
          await route.continue()
        }
      })
      try {
        const started = performance.now()
        await page.goto(`${origin}${base}`, { waitUntil: 'networkidle' })
        await page.getByRole('button', { name: 'Services', exact: true }).click()
        await page.getByRole('link', { name: 'LocalCatalog', exact: true }).press('Enter')
        await page.getByText('Products', { exact: true }).filter({ visible: true }).first().click()
        await page.getByRole('button', { name: 'Execute', exact: true }).click()
        await page.getByRole('row').filter({ hasText: 'Zero desk' }).waitFor({ state: 'visible' })
        const dataReadyMs = Math.round(performance.now() - started)
        await page.waitForLoadState('networkidle')
        await Promise.all(pending)
        const dataAssets = [...assets]
        const hiddenGraphNodes = await page.locator('.vue-flow__node').count()
        const schemaReadsBefore = backend.gatewayRequests.filter(request => request.path.split('?')[0] === '/__odx__/schema').length
        const beforeSchema = performance.now()
        await page.getByRole('tab', { name: 'Schema', exact: true }).click()
        await waitForPaintedGraph(page)
        const schemaReadyMs = Math.round(performance.now() - beforeSchema)
        await page.waitForLoadState('networkidle')
        await Promise.all(pending)
        assert.deepEqual(errors, [])
        const summarize = (entries: typeof assets): { jsBytes: number, cssBytes: number, jsRequests: number, cssRequests: number } => ({
          jsBytes: entries.filter(asset => asset.kind === 'js').reduce((total, asset) => total + asset.bytes, 0),
          cssBytes: entries.filter(asset => asset.kind === 'css').reduce((total, asset) => total + asset.bytes, 0),
          jsRequests: entries.filter(asset => asset.kind === 'js').length,
          cssRequests: entries.filter(asset => asset.kind === 'css').length,
        })
        samples.push({ sample: sample + 1, dataReadyMs, schemaReadyMs, hiddenGraphNodes, schemaReadsBefore, beforeSchema: summarize(dataAssets), afterSchema: summarize(assets), assetsBeforeSchema: dataAssets, assetsAfterSchema: [...assets], errors })
      }
      finally {
        await page.unrouteAll({ behavior: 'wait' })
        await context.close()
      }
    }
    assert.equal(await getExplorerSourceHash(resolve(root, 'packages/explorer')), workspaceSourceHash, 'Explorer changed during measurement.')
    await verifyBuiltFiles()
  }
  catch (error) {
    failure = error instanceof Error ? error.stack || error.message : String(error)
  }
  finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve()))
    await backend?.close()
    const receipt = { startedAt, finishedAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()), runnerHash, sourceHash: manifest.sourceHash, workspaceSourceHash, workspaceMatchesBuild: manifest.sourceHash === workspaceSourceHash, recordBuiltBaseline, lockfileHash, buildId: manifest.buildId, browserVersion, samples, passed: !failure, failure }
    await writeFile(resolve(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ output, passed: !failure, samples: samples.length, failure })}\n`)
  }
  if (failure)
    process.exitCode = 1
}

async function waitForPaintedGraph(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const graph = document.querySelector('.vue-flow')
    return document.querySelectorAll('.vue-flow__node').length === 2 && graph?.parentElement
      && getComputedStyle(graph.parentElement).opacity === '1'
      && graph.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
