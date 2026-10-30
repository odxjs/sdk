import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { Browser, Page } from 'playwright-core'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'
import { consola } from 'consola'
import { chromium } from 'playwright-core'
import { getExplorerSourceHash, getWorkspaceLockHash, listClientFiles } from '../../explorer/scripts/client-contract.mjs'
import { createExplorerBrowserBackend } from '../../explorer/test/browser-backend'

const RE_SIGNIFICANT_WARNING = /hydration|injection|\[Icon\]/i
const RE_HOST_URL = /http:\/\/127\.0\.0\.1:\d+/

async function main(): Promise<void> {
  const run = promisify(execFile)
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const output = resolve(process.argv[2] || join(repoRoot, '.artifacts/explorer-installed-consumer'))
  const pnpm = process.env.npm_execpath
  assert(pnpm, 'Run through pnpm --filter @me-tools/odx-nuxt test:explorer-consumer.')
  await mkdir(output, { recursive: true })
  const directory = await mkdtemp(join(tmpdir(), 'odx-installed-explorer-'))
  assert(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}odx-installed-explorer-`))
  const startedAt = new Date().toISOString()
  const commands: { args: string[], cwd: string, elapsedMs: number }[] = []
  let browser: Browser | undefined
  let page: Page | undefined
  let child: ChildProcess | undefined
  let childClosed: Promise<void> | undefined
  let backend: Awaited<ReturnType<typeof createExplorerBrowserBackend>> | undefined
  let hostLog = ''
  let failure: string | undefined
  let clientBuildId: string | undefined
  const sourceFingerprints: Record<string, unknown> = {}
  const requested: string[] = []
  const responses: { url: string, status: number, body?: string }[] = []

  async function pnpmRun(args: string[], cwd: string): Promise<string> {
    const started = performance.now()
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        CI: '1',
        PNPM_CONFIG_IGNORE_SCRIPTS: args[0] === 'pack' ? 'true' : process.env.PNPM_CONFIG_IGNORE_SCRIPTS,
      }
      // A parent `pnpm run` can pin its workspace. Let every child discover
      // the project from its explicit cwd, including the outside-repo fixture.
      for (const key of Object.keys(env)) {
        if (['NPM_CONFIG_WORKSPACE_DIR', 'PNPM_CONFIG_WORKSPACE_DIR'].includes(key.toUpperCase()))
          delete env[key]
      }
      const result = await run(process.execPath, [pnpm!, ...args], {
        cwd,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env,
      })
      return result.stdout
    }
    finally {
      commands.push({ args, cwd, elapsedMs: Math.round(performance.now() - started) })
    }
  }

  async function stopHost(): Promise<void> {
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null)
      return
    const owned = child
    try {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/pid', String(owned.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      else
        process.kill(-owned.pid!, 'SIGTERM')
    }
    catch (error) {
      if (owned.exitCode === null && owned.signalCode === null)
        throw error
    }
    await Promise.race([childClosed, delay(5000)])
    assert(owned.exitCode !== null || owned.signalCode !== null, 'The owned installed-consumer host did not stop.')
    child = undefined
  }

  async function startHost(cli: string, production = false): Promise<string> {
    const args = production ? [] : ['dev', '--host', '127.0.0.1', '--port', '0']
    child = spawn(process.execPath, [cli, ...args], {
      cwd: directory,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NODE_ENV: production ? 'production' : 'development', NUXT_TELEMETRY_DISABLED: '1', NITRO_HOST: '127.0.0.1', NITRO_PORT: '0', PORT: '0' },
    })
    childClosed = new Promise(resolve => child!.once('close', () => resolve()))
    return new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Installed Nuxt host did not announce its actual URL.')), 120_000)
      const onData = (value: Buffer): void => {
        hostLog += value.toString()
        output += value.toString()
        const clean = stripVTControlCharacters(output)
        const match = clean.match(RE_HOST_URL)
        if (match && (production || clean.includes('Ready in'))) {
          clearTimeout(timer)
          resolve(match[0])
        }
      }
      child!.stdout!.on('data', onData)
      child!.stderr!.on('data', onData)
      child!.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child!.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Installed Nuxt host exited (${code}) before announcing its URL.`))
      })
    })
  }

  async function collectFiles(root: string): Promise<string[]> {
    const files: string[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory())
        files.push(...await collectFiles(path))
      else
        files.push(path)
    }
    return files
  }

  try {
    const expectedManifest = JSON.parse(await readFile(join(repoRoot, 'packages/explorer/dist/client/manifest.json'), 'utf8'))
    assert.equal(expectedManifest.sourceHash, await getExplorerSourceHash(join(repoRoot, 'packages/explorer')), 'Build the Explorer after its source changes before packing.')
    assert.equal(expectedManifest.lockfileHash, await getWorkspaceLockHash(join(repoRoot, 'packages/explorer')), 'Build the Explorer after dependency resolution changes before packing.')
    for (const name of ['metadata', 'core', 'proxy', 'nuxt']) {
      const packageRoot = join(repoRoot, 'packages', name)
      const before = await listClientFiles(join(packageRoot, 'src'))
      for (const file of ['package.json', 'build.config.ts', 'tsconfig.json']) {
        const content = await readFile(join(packageRoot, file)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (content)
          before[file] = createHash('sha256').update(content).digest('hex')
      }
      await pnpmRun(['--filter', `@me-tools/odx-${name}`, 'build'], repoRoot)
      const after = await listClientFiles(join(packageRoot, 'src'))
      for (const file of ['package.json', 'build.config.ts', 'tsconfig.json']) {
        const content = await readFile(join(packageRoot, file)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (content)
          after[file] = createHash('sha256').update(content).digest('hex')
      }
      assert.deepEqual(after, before, `${name} sources changed during the installed-consumer build.`)
      sourceFingerprints[name] = { source: before, output: await listClientFiles(join(packageRoot, 'dist')) }
    }
    const tarballs = join(output, 'packages')
    await mkdir(tarballs, { recursive: true })
    const overrides: Record<string, string> = {}
    for (const name of ['metadata', 'core', 'proxy', 'nuxt']) {
      await pnpmRun(['pack', '--pack-destination', tarballs], join(repoRoot, 'packages', name))
      const manifest = JSON.parse(await readFile(join(repoRoot, 'packages', name, 'package.json'), 'utf8'))
      overrides[manifest.name] = `file:${join(tarballs, `me-tools-odx-${name}-${manifest.version}.tgz`).replaceAll('\\', '/')}`
    }
    const explorerManifest = JSON.parse(await readFile(join(repoRoot, 'packages/explorer/package.json'), 'utf8'))
    // This proves the delivery change on the existing host stack. Dependency
    // upgrades have a separate conformance run rather than floating mid-proof.
    const proxyRequire = createRequire(join(repoRoot, 'packages/proxy/package.json'))
    const pg = JSON.parse(await readFile(proxyRequire.resolve('pg/package.json'), 'utf8'))
    const moduleRequire = createRequire(join(repoRoot, 'packages/nuxt/package.json'))
    const compiler = JSON.parse(await readFile(moduleRequire.resolve('typescript/package.json'), 'utf8'))
    overrides.vue = explorerManifest.devDependencies.vue
    overrides['@vue/compiler-sfc'] = explorerManifest.devDependencies.vue
    // Match the final workspace stack without forcing Devframe's H3 v2 onto v1.
    overrides['h3@^1'] = '1.15.11'
    overrides['@nuxt/devtools'] = '4.0.0'
    overrides['@devframes/agentic'] = '1.2.6'
    const nuxtModuleManifest = JSON.parse(await readFile(join(repoRoot, 'packages/nuxt/package.json'), 'utf8'))
    overrides.nitropack = nuxtModuleManifest.dependencies.nitropack
    overrides.pg = pg.version
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({
      name: 'odx-installed-explorer-conformance',
      private: true,
      type: 'module',
      dependencies: {
        '@me-tools/odx-nuxt': overrides['@me-tools/odx-nuxt'],
        'nuxt': explorerManifest.devDependencies.nuxt,
        'vue': explorerManifest.devDependencies.vue,
      },
      devDependencies: { typescript: compiler.version },
    }, null, 2)}\n`)
    // pnpm 11 reads project settings from YAML, not package.json's pnpm field.
    // JSON is valid YAML and preserves these generated paths without escaping
    // or an additional YAML serialization dependency.
    await writeFile(join(directory, 'pnpm-workspace.yaml'), `${JSON.stringify({ overrides }, null, 2)}\n`)
    await pnpmRun(['install', '--ignore-scripts', '--prefer-offline'], directory)
    const require = createRequire(join(directory, 'package.json'))
    const installedRoot = dirname(require.resolve('@me-tools/odx-nuxt/package.json'))
    const installedRequire = createRequire(join(installedRoot, 'package.json'))
    const installedPackage = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
    const generatorPath = installedRequire.resolve('@odata2ts/odata2ts/package.json')
    const generatorRequire = createRequire(generatorPath)
    const generator = JSON.parse(await readFile(generatorPath, 'utf8'))
    const sdkCompiler = JSON.parse(await readFile(generatorRequire.resolve('typescript/package.json'), 'utf8'))
    assert.equal(sdkCompiler.version, compiler.version, 'The SDK generator must use the host baseline compiler.')
    const installedNuxtPath = require.resolve('nuxt/package.json')
    const nuxtRequire = createRequire(installedNuxtPath)
    const resolvedNuxt = JSON.parse(await readFile(installedNuxtPath, 'utf8'))
    const resolvedVue = JSON.parse(await readFile(require.resolve('vue/package.json'), 'utf8'))
    const resolvedDevtools = JSON.parse(await readFile(nuxtRequire.resolve('@nuxt/devtools/package.json'), 'utf8'))
    await writeFile(join(output, 'dependency-versions.json'), `${JSON.stringify({ nuxt: resolvedNuxt.version, vue: resolvedVue.version, devtools: resolvedDevtools.version, typescript: sdkCompiler.version, generator: generator.version, pg: pg.version }, null, 2)}\n`)
    const installedManifest = JSON.parse(await readFile(join(installedRoot, 'dist/client/manifest.json'), 'utf8'))
    assert.deepEqual(installedManifest, expectedManifest, 'The packed module must contain the freshly built Explorer client.')
    clientBuildId = installedManifest.buildId
    const installedFiles = await listClientFiles(join(installedRoot, 'dist/client'))
    delete installedFiles['manifest.json']
    assert.deepEqual(installedFiles, installedManifest.files)
    // tsx's resolver can fall back to the harness workspace for a missing
    // package. Inspect the real consumer in an unhooked Node process instead.
    const inspection = await run(process.execPath, ['--input-type=module', '--eval', `
      import { createRequire } from 'node:module';
      import { join, dirname } from 'node:path';
      const require = createRequire(join(process.cwd(), 'package.json'));
      const installedRoot = dirname(require.resolve('@me-tools/odx-nuxt/package.json'));
      const installedRequire = createRequire(join(installedRoot, 'package.json'));
      const unexpected = {};
      for (const name of ['@me-tools/odx-explorer', '@nuxt/ui', '@vue-flow/core', 'elkjs']) {
        try { unexpected[name] = installedRequire.resolve(name + '/package.json'); }
        catch (error) { if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error; }
      }
      process.stdout.write(JSON.stringify({ directory: process.cwd(), installedRoot, unexpected }));
    `], {
      cwd: directory,
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
    })
    const provenance = JSON.parse(inspection.stdout)
    await writeFile(join(output, 'installation-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
    assert.equal(provenance.installedRoot, installedRoot)
    assert.deepEqual(provenance.unexpected, {}, 'The installed module must not resolve the Explorer UI runtime graph.')
    assert.equal(installedPackage.dependencies['@me-tools/odx-explorer'], undefined)
    const installedGraph = await readdir(join(directory, 'node_modules/.pnpm'))
    for (const prefix of ['@me-tools+odx-explorer@', '@nuxt+ui@', '@vue-flow+core@', 'elkjs@'])
      assert(!installedGraph.some(name => name.startsWith(prefix)), `Unexpected installed runtime dependency: ${prefix}`)
    backend = await createExplorerBrowserBackend()
    await mkdir(join(directory, 'odx', 'temp'), { recursive: true })
    await writeFile(join(directory, 'odx', 'temp', 'LocalCatalog.edmx'), backend.metadata)
    await mkdir(join(directory, 'pages'), { recursive: true })
    await writeFile(join(directory, 'app.vue'), '<template><NuxtPage /></template>\n')
    await writeFile(join(directory, 'tsconfig.json'), '{"extends":"./.nuxt/tsconfig.json"}\n')
    await writeFile(join(directory, 'pages', 'index.vue'), '<template><h1>Installed ODX host</h1></template>\n')
    await writeFile(join(directory, 'nuxt.config.ts'), `export default defineNuxtConfig({
      modules: ['@me-tools/odx-nuxt'],
      app: { baseURL: '/console/' },
      devtools: { enabled: false },
    odata: { mode: 'sdk', services: [{ name: 'LocalCatalog', route: 'catalog', strategy: 'proxied', url: ${JSON.stringify(backend.serviceUrl)} }] }
    })\n`)
    const cli = join(dirname(require.resolve('nuxt/package.json')), 'bin', 'nuxt.mjs')
    const origin = await startHost(cli)
    consola.info(`Installed host: ${origin}/console/__odx__/client/`)
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
    page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' || (message.type() === 'warning' && RE_SIGNIFICANT_WARNING.test(message.text())))
        errors.push(message.text())
    })
    page.on('request', request => requested.push(request.url()))
    page.on('response', async (response) => {
      if (!response.url().includes('/console/api/') && !response.url().includes('/__odx__/'))
        return
      const record = { url: response.url(), status: response.status(), body: undefined as string | undefined }
      responses.push(record)
      if (!response.ok())
        record.body = await response.text().catch(() => 'Response closed')
    })
    await page.goto(`${origin}/console/__odx__/client/`, { waitUntil: 'networkidle', timeout: 120_000 })
    await page.getByRole('heading', { name: 'ODX Explorer', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Services', exact: true }).click()
    await page.getByRole('link', { name: 'LocalCatalog', exact: true }).press('Enter')
    await page.getByText('Products', { exact: true }).filter({ visible: true }).first().click()
    await page.getByRole('button', { name: 'Execute', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Zero desk' }).waitFor()
    assert(requested.some(url => url.includes('/console/__odx__/config')))
    assert(requested.some(url => url.includes('/console/api/odx/catalog/Products')))
    assert(requested.every(url => new URL(url).origin === origin), 'Explorer must not request a second server or remote icon API.')
    await page.screenshot({ path: join(output, 'installed-host.png') })
    await page.goto(`${origin}/console/__odx__/client/entities/Products`, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'ODX Explorer', exact: true }).waitFor()
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'ODX Explorer', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Services', exact: true }).click()
    await page.getByRole('link', { name: 'LocalCatalog', exact: true }).press('Enter')
    await page.getByText('Products', { exact: true }).filter({ visible: true }).first().click()
    await page.getByRole('button', { name: 'Execute', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Zero desk' }).waitFor()
    assert.equal(errors.length, 0, errors.join('\n'))
    assert(requested.includes(`${origin}/console/__odx__/me`))
    await browser.close()
    browser = undefined
    await stopHost()
    await pnpmRun(['exec', 'nuxt', 'build'], directory)
    const productionFiles = await collectFiles(join(directory, '.output'))
    const clientAssets = new Set((await collectFiles(join(installedRoot, 'dist/client/_nuxt'))).map(path => basename(path)))
    assert(productionFiles.every(path => !clientAssets.has(basename(path))), 'Production output must not retain development Explorer assets.')
    const productionOrigin = await startHost(join(directory, '.output/server/index.mjs'), true)
    const unavailable = await fetch(`${productionOrigin}/console/__odx__/client/`)
    assert.equal(unavailable.status, 404, 'Ordinary production builds must not mount the DevTools Explorer.')
    const productionData = await fetch(`${productionOrigin}/console/api/odx/catalog/Products`)
    assert.equal(productionData.status, 200, 'The configured public synthetic OData service must remain usable in the production host.')
    const body = await productionData.json()
    const rows = Array.isArray(body) ? body : body.value
    assert(rows.some((row: { Name?: string }) => row.Name === 'Zero desk'))
    for (const path of ['/console/__odx__/config', '/console__odx__/config', '/console//__odx__/config']) {
      const response = await fetch(`${productionOrigin}${path}`)
      assert([401, 403, 404].includes(response.status), `Unauthenticated operational metadata must remain inaccessible: ${path} returned ${response.status}`)
    }
    await stopHost()
    await writeFile(join(output, 'requests.json'), `${JSON.stringify(requested, null, 2)}\n`)
  }
  catch (error) {
    failure = error instanceof Error ? error.stack || error.message : String(error)
    await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
    throw error
  }
  finally {
    await browser?.close()
    await stopHost().catch((error: unknown) => {
      failure ||= String(error)
    })
    await backend?.close()
    await writeFile(join(output, 'host.log'), hostLog)
    await writeFile(join(output, 'requests.json'), `${JSON.stringify(requested, null, 2)}\n`)
    await writeFile(join(output, 'responses.json'), `${JSON.stringify(responses, null, 2)}\n`)
    await writeFile(join(output, 'receipt.json'), `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim() !== '', commands, clientBuildId, sourceFingerprints, passed: !failure, failure }, null, 2)}\n`)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
