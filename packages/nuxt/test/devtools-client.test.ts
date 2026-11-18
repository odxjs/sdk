import type { Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createExplorerClientMiddleware } from '../src/devtools-client'

describe('static Explorer delivery', () => {
  it('relocates the entry and runtime API base, serves nested assets and deep links, and keeps missing assets as 404', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'odx-client-mount-'))
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}odx-client-mount-`))
      throw new Error('Unexpected static Explorer fixture directory.')
    let server: Server | undefined
    try {
      const client = join(directory, 'client')
      await mkdir(join(client, '_nuxt', 'nested'), { recursive: true })
      await writeFile(join(directory, 'private.txt'), 'outside-client')
      const template = '<html><head><script type="module" src="/__odx__/client/_nuxt/nested/app.js"></script></head><body><script>window.__NUXT__={config:{public:{},app:{baseURL:"/__odx__/client/"}}};window.__NUXT__.config=window.__NUXT__.config</script></body></html>'
      const script = 'console.log("synthetic-client")'
      const files = { 'index.html': createHash('sha256').update(template).digest('hex'), '_nuxt/nested/app.js': createHash('sha256').update(script).digest('hex') }
      await writeFile(join(client, 'manifest.json'), JSON.stringify({ formatVersion: 1, packageName: '@odxjs/explorer', baseURL: '/__odx__/client/', buildId: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }))
      await writeFile(join(client, 'index.html'), template)
      await writeFile(join(client, '_nuxt', 'nested', 'app.js'), script)
      const route = '/console/__odx__/client'
      const middleware = await createExplorerClientMiddleware(client, { baseURL: `${route}/`, apiBase: '/console' })
      server = createServer((request, response) => {
        request.url = request.url?.slice(route.length) || '/'
        middleware(request, response, () => {
          response.statusCode = 404
          response.end('not found')
        })
      })
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Static Explorer test did not bind a loopback port.')
      const origin = `http://127.0.0.1:${address.port}`
      for (const path of ['/', '/entities/Products', '/entities/Namespace.Type', '/index.html', '/200.html', '/404.html']) {
        const response = await fetch(`${origin}${route}${path}`, { headers: { Accept: 'text/html' } })
        const html = await response.text()
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/html')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(html).toContain(`${route}/_nuxt/nested/app.js`)
        expect(html).toContain('window.__NUXT__.config.public.odxApiBase="/console"')
      }
      const asset = await fetch(`${origin}${route}/_nuxt/nested/app.js`)
      expect(asset.status).toBe(200)
      expect(await asset.text()).toBe('console.log("synthetic-client")')
      for (const path of ['/_nuxt/missing.js', '/_nuxt/', '/_nuxt/missing']) {
        const missing = await fetch(`${origin}${route}${path}`, { headers: { Accept: 'text/html' } })
        expect(missing.status).toBe(404)
        expect(await missing.text()).not.toContain('<html>')
      }
      const head = await fetch(`${origin}${route}/`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      for (const path of ['/../private.txt', '/_nuxt/../../private.txt', '/%2e%2e/private.txt', '/..%5cprivate.txt']) {
        const result = await new Promise<{ status: number | undefined, body: string }>((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port: address.port, path: `${route}${path}` }, (response) => {
            let body = ''
            response.on('data', chunk => body += chunk.toString())
            response.on('end', () => resolve({ status: response.statusCode, body }))
          })
          req.on('error', reject)
          req.end()
        })
        expect(result.status).toBe(404)
        expect(result.body).not.toContain('outside-client')
      }
    }
    finally {
      if (server) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
      }
      await rm(directory, { recursive: true })
    }
  })
})
