import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sirv from 'sirv'

export interface ExplorerClientMount {
  /** Host-owned path including its application base and a trailing slash. */
  baseURL: string
  /** Application base for the host's existing operational API and proxy routes. */
  apiBase: string
}

const RE_LOCAL_MOUNT = /^\/(?:[\w.~%-]+\/)+$/
const RE_DIGEST = /^[a-f\d]{64}$/

function safePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')
    && !path.split('/').some(segment => segment === '.' || segment === '..')
    && ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

export async function createExplorerClientMiddleware(directory: string, mount: ExplorerClientMount) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.formatVersion !== 1 || manifest.baseURL !== '/__odx__/client/'
    || manifest.packageName !== '@odxjs/explorer' || !RE_DIGEST.test(manifest.buildId)
    || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
    || Object.entries(manifest.files).some(([path, hash]) => !safePath(`/${path}`) || typeof hash !== 'string' || !RE_DIGEST.test(hash))
    || createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== manifest.buildId) {
    throw new Error('Unsupported ODX Explorer static client manifest. Rebuild the coordinated ODX packages.')
  }
  if (!RE_LOCAL_MOUNT.test(mount.baseURL) || !safePath(decodeURIComponent(mount.baseURL)))
    throw new Error('Unsupported ODX Explorer host application base.')
  const template = await readFile(join(directory, 'index.html'), 'utf8')
  if (!template.includes('window.__NUXT__.config=')
    || createHash('sha256').update(template).digest('hex') !== manifest.files['index.html']) {
    throw new Error('ODX Explorer static entry is missing its runtime configuration.')
  }
  const apiBase = JSON.stringify(mount.apiBase).replaceAll('<', '\\u003c')
  const relocated = template.replaceAll(manifest.baseURL, mount.baseURL)
  const end = relocated.lastIndexOf('</body>')
  if (end < 0)
    throw new Error('ODX Explorer static entry has no closing body.')
  const html = `${relocated.slice(0, end)}<script>window.__NUXT__.config.public.odxApiBase=${apiBase}</script>${relocated.slice(end)}`
  const assets = sirv(directory, { dev: true, single: false })
  return (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void): void => {
    let path = ''
    try {
      path = decodeURIComponent((request.url || '/').split('?')[0]!)
    }
    catch {}
    const valid = safePath(path)
    const file = path.slice(1)
    const knownFile = Object.hasOwn(manifest.files, file)
    const assetPath = path === '/_nuxt' || path.startsWith('/_nuxt/')
    const htmlEntry = ['/', '/index.html', '/200.html', '/404.html'].includes(path)
    if (valid && (request.method === 'GET' || request.method === 'HEAD')
      && (htmlEntry || (!knownFile && !assetPath && request.headers.accept?.includes('text/html')))) {
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.end(html)
      return
    }
    if (!valid || !knownFile) {
      response.statusCode = 404
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.end('ODX Explorer asset not found.')
      return
    }
    assets(request, response, next)
  }
}
