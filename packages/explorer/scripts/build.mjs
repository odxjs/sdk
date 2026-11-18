import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { buildNuxt, loadNuxt } from 'nuxt/kit'
import { getExplorerSourceHash, getWorkspaceLockHash, listClientFiles } from './client-contract.mjs'
import { replaceExplorerClient } from './replace-client.mjs'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const RE_UI_ICON_CLASS = /^i-lucide-/
const sourceHash = await getExplorerSourceHash(rootDir)
const lockfileHash = await getWorkspaceLockHash(rootDir)
const temporaryParent = resolve(tmpdir())
const temporaryBuild = await mkdtemp(join(temporaryParent, 'odx-explorer-build-'))
process.env.NODE_ENV = 'production'
try {
  const nuxt = await loadNuxt({
    cwd: rootDir,
    dev: false,
    overrides: {
      ssr: false,
      // Incremental Nuxt outputs may retain old hashed assets. A distributable
      // client owns a fresh output rather than copying shared dev/test leftovers.
      buildDir: join(temporaryBuild, 'build'),
      nitro: {
        prerender: { routes: ['/'], crawlLinks: false },
        output: {
          dir: join(temporaryBuild, 'output'),
          serverDir: join(temporaryBuild, 'output/server'),
          publicDir: join(temporaryBuild, 'output/public'),
        },
      },
      // Installed hosts need neither an icon API nor a second Nuxt server.
      icon: { provider: 'none', serverBundle: false, clientBundle: { scan: true } },
    },
  })
  // Nuxt UI resolves these names dynamically from app config, outside the
  // application's source scan. Include the resolved defaults, not a copied list.
  nuxt.hook('icon:clientBundleIcons', (icons) => {
    for (const icon of Object.values(nuxt.options.appConfig.ui?.icons || {})) {
      if (typeof icon === 'string')
        icons.add(icon.replace(RE_UI_ICON_CLASS, 'lucide:'))
    }
  })
  try {
    await buildNuxt(nuxt)
  }
  finally {
    await nuxt.close()
  }

  const publicDir = join(temporaryBuild, 'output/public')
  const clientDir = new URL('../dist/client/', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const html = await readFile(join(publicDir, 'index.html'), 'utf8')
  const baseURL = nuxt.options.app.baseURL
  if (!html.includes(`baseURL:"${baseURL}"`) || !html.includes('window.__NUXT__.config='))
    throw new Error('Explorer build did not emit its expected static client entry.')
  if (sourceHash !== await getExplorerSourceHash(rootDir) || lockfileHash !== await getWorkspaceLockHash(rootDir))
    throw new Error('Explorer sources changed during the build. Rebuild before packing.')
  // Replace only this package's recognized generated client; preserve unknown directories.
  if (resolve(fileURLToPath(clientDir)) !== resolve(join(rootDir, 'dist/client')))
    throw new Error('Unexpected generated Explorer client directory.')
  const previous = await readFile(new URL('manifest.json', clientDir), 'utf8').then(JSON.parse).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!previous && await stat(clientDir).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)))
    throw new Error('Refusing to overwrite an Explorer client directory without a generated manifest.')
  // Existing checkouts may still hold a generated client from before the scope change.
  if (previous && (previous.formatVersion !== 1 || ![manifest.name, '@me-tools/odx-explorer'].includes(previous.packageName)))
    throw new Error('Refusing to replace an unrecognized Explorer client directory.')
  await mkdir(join(rootDir, 'dist'), { recursive: true })
  const staging = await mkdtemp(join(rootDir, 'dist', '.client-'))
  if (dirname(resolve(staging)) !== resolve(join(rootDir, 'dist')))
    throw new Error('Unexpected Explorer client staging directory.')
  try {
    await cp(publicDir, staging, { recursive: true })
    const files = await listClientFiles(staging)
    const buildId = createHash('sha256').update(JSON.stringify(files)).digest('hex')
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({ formatVersion: 1, packageName: manifest.name, packageVersion: manifest.version, baseURL, buildId, sourceHash, lockfileHash, files }, null, 2)}\n`)
    await replaceExplorerClient(staging, fileURLToPath(clientDir), Boolean(previous))
  }
  finally {
    await rm(staging, { recursive: true, force: true })
  }
}
catch (error) {
  console.error(error)
  process.exitCode = 1
}
finally {
  // Delete only the temporary directory allocated above; never follow a
  // caller-supplied path or clear another host's .nuxt/.output directory.
  if (dirname(resolve(temporaryBuild)) === temporaryParent) {
    await rm(temporaryBuild, { recursive: true, force: true })
  }
  else {
    console.error('Unexpected Explorer temporary build directory; cleanup skipped.')
    process.exitCode = 1
  }
}
