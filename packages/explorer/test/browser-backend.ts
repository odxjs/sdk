import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import configHandler from '../../proxy/src/api/config'
import logsHandler from '../../proxy/src/api/logs'
import schemaHandler from '../../proxy/src/api/schema'
import { clearODataLogs, createODataHandler } from '../../proxy/src/index'

interface RecordedRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly body: string
  readonly sessionHeader: string | string[] | undefined
}

interface ExplorerBrowserBackend {
  readonly origin: string
  readonly requests: RecordedRequest[]
  readonly reset: () => Promise<void>
  readonly close: () => Promise<void>
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Explorer browser fixture did not bind a loopback port.')
  return `http://127.0.0.1:${address.port}`
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

/** Actual ODX handlers and a synthetic loopback OData service; no SAP credentials. */
export async function createExplorerBrowserBackend(): Promise<ExplorerBrowserBackend> {
  const directory = await mkdtemp(join(tmpdir(), 'odx-explorer-browser-'))
  const xml = `<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices><Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Browser"><EntityType Name="Product"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.Int32" Nullable="false"/><Property Name="Name" Type="Edm.String"/></EntityType><EntityType Name="Supplier"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.String"/><Property Name="Name" Type="Edm.String"/></EntityType><EntityContainer Name="Container"><EntitySet Name="Products" EntityType="Browser.Product"/><EntitySet Name="Suppliers" EntityType="Browser.Supplier"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`
  const requests: RecordedRequest[] = []
  await mkdir(join(directory, 'odx', 'temp'), { recursive: true })
  await writeFile(join(directory, 'odx', 'temp', 'LocalCatalog.edmx'), xml)
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request)
      chunks.push(Buffer.from(chunk))
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString(), sessionHeader: request.headers['x-odx-browser-session'] })
    response.setHeader('Content-Type', 'application/json')
    if (request.method !== 'GET') {
      if (request.url !== '/odata/Products(0)' || !['PATCH', 'DELETE'].includes(request.method || '')) {
        response.statusCode = 405
        response.end(JSON.stringify({ error: { message: 'Unsupported fixture mutation target.' } }))
        return
      }
      response.end(JSON.stringify({ ID: 0, Name: 'Synthetic write accepted' }))
      return
    }
    response.end(JSON.stringify({ value: request.url?.includes('Suppliers')
      ? [{ ID: 'S1', Name: 'Browser supplier' }]
      : [{ ID: 0, Name: 'Zero desk' }, { ID: 1, Name: 'Desk' }, { Name: 'Unkeyed desk' }] }))
  })
  const upstreamOrigin = await listen(upstream)
  const config = {
    rootDir: directory,
    buildDir: directory,
    mode: 'sdk' as const,
    basePath: '/api/odx',
    devtools: { enabled: true },
    services: [{ name: 'LocalCatalog', route: 'catalog', url: `${upstreamOrigin}/odata`, strategy: 'proxied' as const, proxyMode: 'buffer' as const }],
  }
  const app = createApp()
  app.use(defineEventHandler((event) => {
    event.context.odataConfig = config
  }))
  app.use('/__odx__/config', configHandler)
  app.use('/__odx__/schema', schemaHandler)
  app.use('/__odx__/logs', logsHandler)
  app.use('/__odx__/me', defineEventHandler(() => ({ user: { id: 'synthetic-browser' } })))
  app.use(createODataHandler(config))
  const gateway = createServer(toNodeListener(app))
  const origin = await listen(gateway)
  return {
    origin,
    requests,
    async reset() {
      requests.splice(0)
      await clearODataLogs()
    },
    async close() {
      await stop(gateway)
      await stop(upstream)
      // Delete only this fixture's own, explicitly allocated temporary directory.
      if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}odx-explorer-browser-`))
        throw new Error('Unexpected Explorer fixture cleanup path.')
      await rm(directory, { recursive: true })
    },
  }
}
