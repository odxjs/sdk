import { deepStrictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { cp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: [
    { input: 'src/module', name: 'module' },
    { input: 'src/generate', name: 'generate' },
    { input: 'src/server', name: 'server' },
  ],
  declaration: true,
  clean: true,
  rollup: {
    emitCJS: false,
  },
  hooks: {
    'build:done': async function (context) {
      if (context.options.stub || context.options.watch)
        return
      const require = createRequire(import.meta.url)
      let manifestPath: string
      try {
        manifestPath = require.resolve('@me-tools/odx-explorer/client-manifest')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        const explorerRoot = dirname(require.resolve('@me-tools/odx-explorer/package.json'))
        const { getExplorerSourceHash, getWorkspaceLockHash, listClientFiles } = await import(pathToFileURL(join(explorerRoot, 'scripts/client-contract.mjs')).href)
        if (manifest.formatVersion !== 1 || manifest.packageName !== '@me-tools/odx-explorer'
          || manifest.packageVersion !== context.pkg?.version || manifest.sourceHash !== await getExplorerSourceHash(explorerRoot)
          || manifest.lockfileHash !== await getWorkspaceLockHash(explorerRoot)) {
          throw new Error('Explorer client source or package version does not match.')
        }
        const files = await listClientFiles(dirname(manifestPath))
        delete files['manifest.json']
        deepStrictEqual(files, manifest.files, 'Explorer static files do not match their manifest.')
        if (createHash('sha256').update(JSON.stringify(files)).digest('hex') !== manifest.buildId)
          throw new Error('Explorer static build identity does not match its bytes.')
      }
      catch (cause) {
        throw new Error('Build the matching ODX Explorer static client before building the Nuxt package: pnpm --filter @me-tools/odx-explorer build', { cause })
      }
      await cp(dirname(manifestPath), join(context.options.outDir, 'client'), { recursive: true })
    },
  },
})
