import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function listClientFiles(directory, prefix = '') {
  const files = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      Object.assign(files, await listClientFiles(path, relative))
    else
      files[relative] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  return Object.fromEntries(Object.keys(files).sort().map(path => [path, files[path]]))
}

export async function getExplorerSourceHash(directory) {
  const files = {}
  for (const path of ['app.vue', 'app.css', 'app.config.ts', 'nuxt.config.ts', 'package.json'])
    files[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex')
  for (const path of ['components', 'composables', 'utils', 'scripts'])
    Object.assign(files, await listClientFiles(join(directory, path), path))
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(files).sort().map(path => [path, files[path]])))).digest('hex')
}

export async function getWorkspaceLockHash(directory) {
  const content = await readFile(join(directory, '../../pnpm-lock.yaml')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  return content ? createHash('sha256').update(content).digest('hex') : null
}
