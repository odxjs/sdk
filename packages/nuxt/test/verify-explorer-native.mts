import type { ChildProcess } from 'node:child_process'
import type { Browser, Frame, Page } from 'playwright-core'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { consola } from 'consola'
import { chromium } from 'playwright-core'
import { getExplorerSourceHash } from '../../explorer/scripts/client-contract.mjs'
import { createExplorerBrowserBackend } from '../../explorer/test/browser-backend'

const RE_LOCAL = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/
const RE_OTP = /\b\d{6}\b/g
const RE_URL = /(?:https?|wss?):\/\/[^\s'"<>)]*/g
const RE_CREDENTIAL_LINE = /auth|token|code|secret|^\s*\d{6,12}\s*$/i
const RE_LAUNCHER = /DevTools launcher/
const RE_UNAUTHORIZED = /Nicht autorisiert|Unauthorized/
const RE_REISSUE = /Einmalpasswort neu ausstellen|Re-?issue/
const RE_FIRST_DIGIT = /(?:Ziffer|Digit) 1 (?:von|of) 6/
const RE_AUTHORIZE = /^Autorisieren$|^Authorize$/
const RE_START = /Starten|Launch|^Start$/

async function poll<T>(read: () => T | Promise<T>, message: string, timeout = 30_000): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    const value = await read()
    if (value)
      return value
    await setTimeout(100)
  }
  throw new Error(message)
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const require = createRequire(import.meta.url)
  const output = resolve(process.argv[2] || join(root, '.artifacts/explorer-native-host'))
  const startedAt = new Date().toISOString()
  const start = performance.now()
  const milestones: Record<string, number> = {}
  const errors: string[] = []
  const failedResponses: { url: string, status: number }[] = []
  const failedRequests: { url: string, instance: string | null, error: string | undefined }[] = []
  const clientRequests = new Map<string, number>()
  const operationRequests: string[] = []
  const connectedSockets: string[] = []
  const base = '/console/_nuxt/odx-explorer/'
  let log = ''
  let otp: string | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let child: ChildProcess | undefined
  let hostExit: Promise<void> | undefined
  let hostClosed = false
  const cleanup = { graceful: false, fallback: false, closed: false }
  let failure: unknown
  let origin: string | undefined
  let explorerSourceHash: string | undefined
  let retainedFramesAtStop = 0
  const recordPollingBaseline = process.argv.includes('--record-polling-baseline')
  let polling: { hiddenWindowMs: number, hiddenReads: number, hiddenDocumentState: string, resumeLatencyMs: number, asserted: boolean } | undefined
  const backend = await createExplorerBrowserBackend()
  await mkdir(output, { recursive: true })

  function milestone(name: string): void {
    milestones[name] = Math.round(performance.now() - start)
    consola.info(`Explorer native: ${name} (${milestones[name]} ms)`)
  }
  function redact(value: string): string {
    const text = stripVTControlCharacters(otp ? value.replaceAll(otp, '[local OTP omitted]') : value)
    return text.replace(RE_URL, (url) => {
      try {
        const parsed = new URL(url)
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      }
      catch { return '[URL omitted]' }
    })
  }
  async function stopHost(): Promise<void> {
    if (!child || !child.pid || hostClosed || child.signalCode !== null || child.exitCode !== null) {
      cleanup.closed = true
      return
    }
    const owned = child
    if (owned.connected)
      owned.send('odx-explorer-test:close')
    await Promise.race([hostExit, setTimeout(5000)])
    cleanup.graceful = hostClosed
    if (!hostClosed) {
      cleanup.fallback = true
      try {
        if (process.platform === 'win32')
          execFileSync('taskkill', ['/pid', String(owned.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        else
          process.kill(-owned.pid!, 'SIGTERM')
      }
      catch (error) {
        if (!hostClosed && owned.exitCode === null && owned.signalCode === null)
          failure ||= error
      }
    }
    await Promise.race([hostExit, setTimeout(5000)])
    cleanup.closed = hostClosed
    if (!cleanup.graceful)
      failure ||= new Error('The native host did not complete graceful disposal; inspect the cleanup receipt.')
  }
  async function terminalFrame(): Promise<Frame> {
    return poll(async () => {
      for (const frame of page!.frames()) {
        if (await frame.getByTitle('Kill process', { exact: true }).isVisible())
          return frame
      }
    }, 'The native terminal did not expose its running process.')
  }
  async function openOdx(): Promise<void> {
    await page!.getByRole('button', { name: 'Nuxt', exact: true }).click()
    await page!.getByRole('button', { name: 'Overview', exact: true }).click()
    // Await the group's own initial navigation before selecting its module.
    await page!.frameLocator('iframe[src*="/__nuxt_devtools__/client/"]').getByText('Star on GitHub', { exact: true }).waitFor()
    await page!.getByRole('button', { name: 'ODX', exact: true }).click()
  }
  async function waitForClient(selector: string, instance: string): Promise<void> {
    await poll(async () => {
      // Devframe retains stopped frames. Their deliberate termination can abort
      // outstanding imports while a different instance is already starting.
      const startupFailures = failedRequests.filter(request => request.instance === instance)
      if (errors.length || startupFailures.length)
        throw new Error(`Explorer client startup failed: ${JSON.stringify({ errors, failedRequests: startupFailures })}`)
      return page!.frameLocator(selector).getByRole('button', { name: 'Services', exact: true }).isVisible()
    }, 'The native Explorer client did not become interactive.', 120_000)
  }

  try {
    explorerSourceHash = await getExplorerSourceHash(join(root, 'packages/explorer'))
    const environment: Record<string, string | undefined> = { ...process.env, RAYON_NUM_THREADS: '1', NODE_ENV: 'development', NUXT_TELEMETRY_DISABLED: '1', ODX_EXPLORER_TEST_SERVICE_URL: backend.serviceUrl }
    delete environment.CI
    child = spawn(process.execPath, [join(dirname(require.resolve('nuxt/package.json')), 'bin/nuxt.mjs'), 'dev', join(root, 'packages/nuxt/test/fixtures/explorer-native'), '--host', '127.0.0.1', '--port', '0'], {
      cwd: root,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: environment,
    })
    // `close` also follows a failed spawn; attach before asynchronous work.
    hostExit = new Promise(resolve => child!.once('close', () => {
      hostClosed = true
      resolve()
    }))
    child.stdout!.on('data', value => log += value.toString())
    child.stderr!.on('data', value => log += value.toString())
    child.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'nuxt:internal:dev:log' && 'message' in message && typeof message.message === 'string')
        log += `\n${message.message}`
    })
    let spawnError: Error | undefined
    child.on('error', error => spawnError = error)
    origin = await poll(() => {
      if (spawnError)
        throw spawnError
      if (child!.exitCode !== null)
        throw new Error(`Native host exited (${child!.exitCode}).`)
      const clean = stripVTControlCharacters(log)
      return clean.includes('Ready in') ? clean.match(RE_LOCAL)?.[1] : undefined
    }, 'The native host did not become ready.', 120_000)
    milestone('host-ready')
    const unopened = await fetch(`${origin}${base}`)
    assert.equal(unopened.status, 503)
    assert.match(await unopened.text(), RE_LAUNCHER)
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    page.setDefaultTimeout(30_000)
    page.on('pageerror', error => errors.push(redact(error.message)))
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push(redact(message.text()))
    })
    page.on('response', (response) => {
      if (response.status() >= 400)
        failedResponses.push({ url: redact(response.url()), status: response.status() })
    })
    page.on('requestfailed', (request) => {
      const frame = request.serviceWorker() ? undefined : request.frame()
      failedRequests.push({ url: redact(request.url()), instance: frame ? new URL(frame.url()).searchParams.get('odxInstance') : null, error: request.failure()?.errorText })
    })
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith(base))
        clientRequests.set(redact(request.url()), (clientRequests.get(redact(request.url())) || 0) + 1)
      if (url.pathname.startsWith('/console/__odx__/') || url.pathname.startsWith('/console/custom/odata/'))
        operationRequests.push(`${url.origin}${url.pathname}`)
    })
    page.on('websocket', socket => socket.on('framereceived', (event) => {
      if (String(event.payload).includes('"type":"connected"'))
        connectedSockets.push(redact(socket.url()))
    }))
    await page.goto(`${origin}/console/`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'ODX native host', exact: true }).waitFor()
    await page.keyboard.press('Alt+Shift+D')
    await page.getByRole('button', { name: RE_UNAUTHORIZED }).press('Enter')
    const offset = log.length
    await page.getByRole('button', { name: RE_REISSUE }).click()
    // Exercise the default local OTP flow. Never disable host authorization,
    // persist the code or pass it through a command-line argument.
    otp = await poll(() => [...stripVTControlCharacters(log.slice(offset)).matchAll(RE_OTP)].at(-1)?.[0], 'The host did not issue a fresh local OTP.')
    await page.getByRole('textbox', { name: RE_FIRST_DIGIT }).click()
    await page.keyboard.type(otp)
    await page.getByRole('button', { name: RE_AUTHORIZE }).waitFor({ state: 'hidden' })
    milestone('authorized')
    await openOdx()
    await page.getByText('Starts the repository development client on demand. OData requests stay on this application host.', { exact: true }).waitFor()
    await page.screenshot({ path: join(output, 'launcher.png') })
    await page.getByRole('button', { name: RE_START }).click()
    const clientSelector = `iframe[src*="${base}?odxInstance=1"]`
    const client = page.frameLocator(clientSelector)
    await waitForClient(clientSelector, '1')
    milestone('client-ready')
    const firstClientUrl = new URL((await page.locator(clientSelector).getAttribute('src'))!, origin).href
    await client.getByRole('button', { name: 'Services', exact: true }).click()
    await client.getByRole('link', { name: 'LocalCatalog', exact: true }).press('Enter')
    await client.getByText('Products', { exact: true }).filter({ visible: true }).first().click()
    await client.getByRole('button', { name: 'Execute', exact: true }).click()
    await client.getByRole('row').filter({ hasText: 'Zero desk' }).waitFor()
    assert(backend.requests.some(request => request.method === 'GET' && request.url === '/odata/Products'))
    await page.screenshot({ path: join(output, 'data.png') })
    await client.getByRole('tab', { name: 'Schema', exact: true }).click()
    await client.locator('.vue-flow__node').nth(1).waitFor()
    await poll(() => client.locator('.vue-flow__node').first().evaluate(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })), 'Schema nodes were not painted.')
    await page.screenshot({ path: join(output, 'schema.png') })
    await client.getByRole('button', { name: 'Logs', exact: true }).first().click()
    await client.getByRole('row').filter({ hasText: 'Products', visible: true }).first().waitFor()
    await client.getByRole('button', { name: 'Proxy', exact: true }).click()
    await client.getByRole('heading', { name: 'Proxy Engine', exact: true }).waitFor()
    await poll(() => connectedSockets.includes(`${origin!.replace('http:', 'ws:')}${base}_nuxt/`), 'Explorer HMR did not connect through the application origin.')
    assert(operationRequests.some(url => url.endsWith('/console/custom/odata/catalog/Products')))
    assert(operationRequests.every(url => new URL(url).origin === origin))
    milestone('data-schema-logs-proxy-hmr')
    await page.screenshot({ path: join(output, 'proxy.png') })

    const logReads = (): number => operationRequests.filter(url => url.endsWith('/console/__odx__/logs')).length
    await page.getByRole('button', { name: 'Overview', exact: true }).click()
    await poll(async () => await page!.locator(clientSelector).evaluate(element => getComputedStyle(element).pointerEvents === 'none'), 'The native group did not hide its Explorer pane.')
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    const hiddenDocumentState = await client.locator('body').evaluate(() => document.visibilityState)
    const hiddenStart = performance.now()
    const beforeHidden = logReads()
    // Observe more than two real polling intervals, without mocking the clock.
    await setTimeout(6500)
    const hiddenReads = logReads() - beforeHidden
    const hiddenWindowMs = Math.round(performance.now() - hiddenStart)
    const beforeReturn = logReads()
    const returnStart = performance.now()
    await page.getByRole('button', { name: 'ODX', exact: true }).click()
    await poll(() => logReads() > beforeReturn, 'Explorer did not reconcile traffic after returning.', 4500)
    polling = { hiddenWindowMs, hiddenReads, hiddenDocumentState, resumeLatencyMs: Math.round(performance.now() - returnStart), asserted: !recordPollingBaseline }
    if (!recordPollingBaseline)
      assert.equal(hiddenReads, 0, 'A hidden native dock must not keep polling traffic.')
    milestone('hidden-polling-reconciliation')

    await page.getByRole('button', { name: 'Terminals', exact: true }).click()
    const terminal = await terminalFrame()
    await terminal.getByTitle('Kill process', { exact: true }).click()
    await terminal.getByRole('alertdialog').getByRole('button', { name: 'Kill process', exact: true }).click()
    await openOdx()
    await page.getByText('Starts the repository development client on demand. OData requests stay on this application host.', { exact: true }).waitFor()
    // Devframe caches visited iframe elements. The launcher and stopped HTTP
    // contract, followed by a new document navigation, define restart here.
    retainedFramesAtStop = await page.locator(`iframe[src*="${base}"]`).count()
    await poll(async () => await page!.locator(clientSelector).evaluate(element => getComputedStyle(element).pointerEvents === 'none'), 'The stopped frame remained interactive.')
    const stopped = await fetch(`${origin}${base}`)
    assert.equal(stopped.status, 503)
    const restartedDocument = page.waitForEvent('framenavigated', {
      predicate: (frame: Frame) => {
        const url = new URL(frame.url())
        return url.pathname.startsWith(base) && url.searchParams.get('odxInstance') !== new URL(firstClientUrl).searchParams.get('odxInstance')
      },
      timeout: 120_000,
    })
    await page.getByRole('button', { name: RE_START }).click()
    await restartedDocument
    const restartedSelector = `iframe[src*="${base}?odxInstance=2"]`
    await waitForClient(restartedSelector, '2')
    assert.notEqual(new URL((await page.locator(restartedSelector).getAttribute('src'))!, origin).href, firstClientUrl)
    milestone('native-terminate-relaunch')
    assert.deepEqual(errors, [])
    assert.deepEqual(failedResponses, [])
    await page.screenshot({ path: join(output, 'restarted.png') })
  }
  catch (error) {
    failure = error
    if (page) {
      await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined)
      await writeFile(join(output, 'failure-ui.txt'), redact(await page.locator('body').ariaSnapshot().catch(() => 'Snapshot unavailable.')))
      const terminals = page.getByRole('button', { name: 'Terminals', exact: true })
      if (await terminals.isVisible()) {
        await terminals.click().catch(() => undefined)
        await page.screenshot({ path: join(output, 'failure-terminal.png') }).catch(() => undefined)
        await writeFile(join(output, 'failure-terminal-ui.txt'), redact(await page.locator('body').ariaSnapshot().catch(() => 'Snapshot unavailable.')))
      }
    }
  }
  finally {
    await browser?.close()
    await stopHost()
    await backend.close()
    if (explorerSourceHash && explorerSourceHash !== await getExplorerSourceHash(join(root, 'packages/explorer')))
      failure ||= new Error('Explorer sources changed during the native browser gate.')
    const source = createHash('sha256')
    for (const file of ['packages/nuxt/src/devtools.ts', 'packages/nuxt/src/devtools-contributor.ts', 'packages/explorer/nuxt.config.ts', 'pnpm-lock.yaml'])
      source.update(await readFile(join(root, file)))
    await writeFile(join(output, 'host.log'), redact(log).split('\n').map(line => RE_CREDENTIAL_LINE.test(line) ? '[local authorization/diagnostic line omitted]' : line).join('\n'))
    await writeFile(join(output, 'receipt.json'), `${JSON.stringify({
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - start),
      command: 'pnpm --filter @me-tools/odx-nuxt test:explorer-native',
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()),
      sourceHash: source.digest('hex'),
      explorerSourceHash,
      runnerHash: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
      exitCode: failure ? 1 : 0,
      milestones,
      origin,
      operationRequests,
      connectedSockets,
      errors,
      failedResponses,
      failedRequests,
      clientRequests: Object.fromEntries(clientRequests),
      cleanup,
      retainedFramesAtStop,
      polling,
      failure: failure ? redact(String(failure)) : undefined,
    }, null, 2)}\n`)
  }
  if (failure)
    throw new Error(redact(String(failure)))
}

main().catch((error: unknown) => {
  consola.error(error)
  process.exitCode = 1
})
