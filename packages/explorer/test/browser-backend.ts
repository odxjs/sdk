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
  readonly ifMatch: string | string[] | undefined
}

interface ExplorerBrowserBackend {
  readonly origin: string
  readonly serviceUrl: string
  readonly metadata: string
  readonly requests: RecordedRequest[]
  readonly gatewayRequests: { path: string, url?: string }[]
  readonly reset: () => Promise<void>
  readonly advanceRecord: () => void
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
export async function createExplorerBrowserBackend(options: { version?: 'v2' | 'v4', compositeKey?: boolean, secondService?: boolean, concurrency?: boolean, expanded?: boolean } = {}): Promise<ExplorerBrowserBackend> {
  const directory = await mkdtemp(join(tmpdir(), 'odx-explorer-browser-'))
  const version = options.version ?? 'v4'
  const edmxNamespace = version === 'v2' ? 'http://schemas.microsoft.com/ado/2007/06/edmx' : 'http://docs.oasis-open.org/odata/ns/edmx'
  const edmNamespace = version === 'v2' ? 'http://schemas.microsoft.com/ado/2008/09/edm' : 'http://docs.oasis-open.org/odata/ns/edm'
  const key = options.compositeKey ? '<PropertyRef Name="Tenant"/><PropertyRef Name="ID"/>' : '<PropertyRef Name="ID"/>'
  const idType = options.compositeKey ? 'Edm.Int64' : 'Edm.Int32'
  const navigation = options.expanded ? '<NavigationProperty Name="Supplier" Type="Browser.Supplier"/>' : ''
  const xml = `<edmx:Edmx xmlns:edmx="${edmxNamespace}" Version="${version === 'v2' ? '1.0' : '4.0'}"><edmx:DataServices><Schema xmlns="${edmNamespace}" Namespace="Browser"><EntityType Name="Product"><Key>${key}</Key><Property Name="ID" Type="${idType}" Nullable="false"/>${options.compositeKey ? '<Property Name="Tenant" Type="Edm.String" Nullable="false"/>' : ''}<Property Name="Name" Type="Edm.String"/>${navigation}</EntityType><EntityType Name="Supplier"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.String"/><Property Name="Name" Type="Edm.String"/></EntityType><EntityContainer Name="Container"><EntitySet Name="Products" EntityType="Browser.Product"/><EntitySet Name="Suppliers" EntityType="Browser.Supplier"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`
  // Named composite-key ordering is semantically insignificant in OData.
  const suffix = version === 'v2' ? 'L' : ''
  const mutationPaths = options.compositeKey
    ? [`/odata/Products(Tenant='O''Brien%2F%26%3F',ID=0${suffix})`, `/odata/Products(ID=0${suffix},Tenant='O''Brien%2F%26%3F')`]
    : ['/odata/Products(0)']
  const initialProducts = (): Record<string, unknown>[] => [
    { ID: 0, Name: 'Zero desk', ...(options.compositeKey ? { Tenant: 'O\'Brien/&?' } : {}), ...(options.expanded ? { Supplier: { ID: 'S1', Name: 'Expanded supplier' } } : {}) },
    { ID: 1, Name: 'Desk' },
    { Name: 'Unkeyed desk' },
  ]
  let products = initialProducts()
  let revision = 1
  const etag = (): string => `W/"${revision}"`
  const requests: RecordedRequest[] = []
  const gatewayRequests: { path: string, url?: string }[] = []
  await mkdir(join(directory, 'odx', 'temp'), { recursive: true })
  await writeFile(join(directory, 'odx', 'temp', 'LocalCatalog.edmx'), xml)
  if (options.secondService)
    await writeFile(join(directory, 'odx', 'temp', 'OtherCatalog.edmx'), xml)
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request)
      chunks.push(Buffer.from(chunk))
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString(), sessionHeader: request.headers['x-odx-browser-session'], ifMatch: request.headers['if-match'] })
    if (request.method === 'GET' && request.url === '/odata/$metadata') {
      response.setHeader('Content-Type', 'application/xml')
      response.end(xml)
      return
    }
    response.setHeader('Content-Type', 'application/json')
    if (request.method !== 'GET') {
      if (options.concurrency && version === 'v4'
        && (request.headers.accept !== 'application/json;IEEE754Compatible=true'
          || request.headers['content-type'] !== 'application/json;IEEE754Compatible=true')) {
        response.statusCode = 415
        response.end(JSON.stringify({ error: { message: 'The V4 fixture requires exact IEEE754 JSON negotiation.' } }))
        return
      }
      if (!mutationPaths.includes(request.url || '') || ![version === 'v2' ? 'MERGE' : 'PATCH', 'DELETE'].includes(request.method || '')) {
        response.statusCode = 405
        response.end(JSON.stringify({ error: { message: 'Unsupported fixture mutation target.' } }))
        return
      }
      const index = products.findIndex(record => String(record.ID) === '0')
      if (index < 0) {
        response.statusCode = 404
        response.end(JSON.stringify({ error: { message: 'The fixture record no longer exists.' } }))
        return
      }
      if (options.concurrency && request.headers['if-match'] !== etag()) {
        response.statusCode = 412
        response.end(JSON.stringify({ error: { message: version === 'v2' ? { lang: 'en', value: 'The record changed on the service.' } : 'The record changed on the service.' } }))
        return
      }
      if (request.method === 'DELETE') {
        products.splice(index, 1)
        response.statusCode = 204
        response.end()
        return
      }
      try {
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString())
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
          || ('ID' in payload && String(payload.ID) !== '0')
          || (options.compositeKey && 'Tenant' in payload && payload.Tenant !== 'O\'Brien/&?')) {
          throw new Error('The fixture accepts partial record objects without key changes.')
        }
        products[index] = { ...products[index], ...payload }
        revision++
        if (options.concurrency)
          response.setHeader('ETag', etag())
        response.end(JSON.stringify(products[index]))
      }
      catch {
        response.statusCode = 400
        response.end(JSON.stringify({ error: { message: 'Invalid fixture update payload.' } }))
      }
      return
    }
    const rows = request.url?.includes('Suppliers')
      ? [{ ID: 'S1', Name: 'Browser supplier' }]
      : products.map(record => options.concurrency && record.ID === 0
          ? { ...record, ...(version === 'v2' ? { __metadata: { etag: etag() } } : { '@odata.etag': etag() }) }
          : record)
    const projected = rows.map((record) => {
      const projected: Record<string, unknown> = { ...record }
      if (!request.url?.includes('$expand=Supplier'))
        delete projected.Supplier
      return projected
    })
    response.end(JSON.stringify(version === 'v2' ? { d: { results: projected } } : { value: projected }))
  })
  const upstreamOrigin = await listen(upstream)
  const config = {
    rootDir: directory,
    buildDir: directory,
    mode: 'sdk' as const,
    basePath: '/api/odx',
    devtools: { enabled: true },
    services: [
      { name: 'LocalCatalog', route: 'catalog', url: `${upstreamOrigin}/odata`, strategy: 'proxied' as const, proxyMode: 'buffer' as const },
      ...(options.secondService ? [{ name: 'OtherCatalog', route: 'other', url: `${upstreamOrigin}/odata`, strategy: 'proxied' as const, proxyMode: 'buffer' as const }] : []),
    ],
  }
  const app = createApp()
  app.use(defineEventHandler((event) => {
    gatewayRequests.push({ path: event.path, url: event.node.req.url })
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
    serviceUrl: `${upstreamOrigin}/odata`,
    metadata: xml,
    requests,
    gatewayRequests,
    advanceRecord() {
      revision++
      const record = products.find(record => record.ID === 0)
      if (record)
        record.Name = 'Server desk'
    },
    async reset() {
      requests.splice(0)
      gatewayRequests.splice(0)
      products = initialProducts()
      revision = 1
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
