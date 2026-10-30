import { useNuxtApp } from 'nuxt/app'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useEntityExplorer } from '../composables/useEntityExplorer'
import { buildEntityPreviewCacheKey, buildOdxApiEndpoint, buildRuntimeProxyUrl, buildSchemaEndpointUrl, supportsSdkGeneration, useSharedODataState } from '../composables/useODataState'

// Mock global fetch
globalThis.fetch = vi.fn()

function createEntityExplorer(): ReturnType<typeof useEntityExplorer> {
  return useNuxtApp().vueApp.runWithContext(useEntityExplorer)
}

describe('explorer State Composable', () => {
  it('bootstraps its Nuxt test app without initialization errors', () => {
    const error = useNuxtApp().payload.error
    expect(error, error?.cause instanceof Error ? error.cause.stack : error?.message).toBeFalsy()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(globalThis.fetch).mockReset()
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ entities: [] })))
    globalThis.localStorage?.clear()
    const {
      configError,
      logsError,
      activeTab,
      config,
      filteredLogs,
      hasActiveLogFilters,
      hasFilteredOutLogs,
      logFilterService,
      logFilterStatus,
      logSearch,
      logs,
      previewData,
      previewOwner,
      previewError,
      previewLoading,
      queryInput,
      queryMethod,
      queryState,
      selectedEntity,
      selectedService,
      selectedTraceLogId,
      clearSessionHeaders,
      useCORSBridge,
      entityDataCache,
      entitySchema,
      entitySchemaLoading,
      updateServiceHealth,
    } = useSharedODataState()
    configError.value = null
    logsError.value = null
    vi.stubGlobal('useSharedODataState', useSharedODataState)
    vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
    ;['Northwind', 'SAP'].forEach(name => updateServiceHealth(name, 'checking', true))
    activeTab.value = 'overview'
    config.value = { basePath: '/__odx__', services: [] }
    logFilterService.value = null
    logFilterStatus.value = 'all'
    logSearch.value = ''
    logs.value = []
    selectedService.value = null
    selectedEntity.value = null
    selectedTraceLogId.value = null
    previewLoading.value = false
    previewError.value = null
    previewData.value = null
    previewOwner.value = null
    queryInput.value = '?'
    queryMethod.value = 'GET'
    queryState.value = {
      filters: {
        type: 'group',
        logic: 'and',
        items: [],
      },
      select: [],
      expand: [],
      sortBy: [],
      top: null,
      skip: null,
    }
    entitySchema.value = null
    entitySchemaLoading.value = false
    entityDataCache.value = {}
    clearSessionHeaders()
    useCORSBridge.value = true
    expect(filteredLogs.value).toEqual([])
    expect(hasActiveLogFilters.value).toBe(false)
    expect(hasFilteredOutLogs.value).toBe(false)
  })

  it('fetches config correctly', async () => {
    const mockConfig = { basePath: '/api', mode: 'sdk', services: [] }
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockConfig,
    })

    const { fetchConfig, config } = useSharedODataState()
    await fetchConfig()

    expect(globalThis.fetch).toHaveBeenCalledWith('/__odx__/config', { signal: expect.any(AbortSignal) })
    expect(config.value.basePath).toBe('/api')
  })

  it('shares the entity controller and ignores an older Execute response, including its cache and loading state', async () => {
    const state = useSharedODataState()
    state.selectedService.value = { name: 'Northwind', route: 'northwind', strategy: 'proxied' } as any
    state.selectedEntity.value = 'Products'
    await nextTick()
    const explorer = createEntityExplorer()
    expect(createEntityExplorer()).toBe(explorer)
    let resolveOld!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => resolveOld = resolve))
    state.queryInput.value = '?$top=1'
    const oldRead = explorer.refreshEntityData()
    const oldSignal = vi.mocked(fetch).mock.calls.at(-1)![1]!.signal!
    let resolveNew!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => resolveNew = resolve))
    state.queryInput.value = '?$top=2'
    const newRead = createEntityExplorer().refreshEntityData()
    expect(oldSignal.aborted).toBe(true)
    resolveOld(new Response(JSON.stringify({ value: [{ ID: 'obsolete' }] })))
    await oldRead
    expect(state.previewLoading.value).toBe(true)
    expect(state.previewData.value).toBeNull()
    resolveNew(new Response(JSON.stringify({ value: [{ ID: 'latest' }] })))
    await newRead
    expect(state.previewData.value).toEqual([{ ID: 'latest' }])
    expect(state.entityDataCache.value[buildEntityPreviewCacheKey('Northwind', 'Products')])
      .toMatchObject({ data: [{ ID: 'latest' }], query: '?$top=2' })
    expect(state.previewLoading.value).toBe(false)
  })

  it('rejects late data and schema when switching services with the same entity name', async () => {
    const state = useSharedODataState()
    let resolveSchema!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => resolveSchema = resolve))
    state.selectedService.value = { name: 'Northwind', route: 'northwind', strategy: 'proxied' } as any
    state.selectedEntity.value = 'Products'
    let resolveData!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => resolveData = resolve))
    const oldRead = createEntityExplorer().refreshEntityData()
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ entities: [{ name: 'SAP product' }] })))
    state.selectedService.value = { name: 'SAP', route: 'sap', strategy: 'proxied' } as any
    await nextTick()
    await nextTick()
    resolveSchema(new Response(JSON.stringify({ entities: [{ name: 'Wrong product' }] })))
    resolveData(new Response(JSON.stringify({ value: [{ ID: 'wrong-service' }] })))
    await oldRead
    await nextTick()
    expect(state.entitySchema.value).toEqual({ entities: [{ name: 'SAP product' }] })
    expect(state.previewData.value).toBeNull()
    expect(state.entityDataCache.value[buildEntityPreviewCacheKey('SAP', 'Products')]).toBeUndefined()
    expect(state.entitySchemaLoading.value).toBe(false)
  })

  it('refreshes logs correctly', async () => {
    const mockLogs = [{ id: '1', method: 'GET', url: '/t', service: 'S' }]
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockLogs,
    })

    const { refreshLogs, logs } = useSharedODataState()
    await refreshLogs()

    expect(globalThis.fetch).toHaveBeenCalledWith('/__odx__/logs', { signal: expect.any(AbortSignal) })
    expect(logs.value).toHaveLength(1)
    expect(logs.value[0]!.id).toBe('1')
  })

  it('coalesces slow log polls and prevents an old poll restoring cleared history', async () => {
    const state = useSharedODataState()
    let resolveRead!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => resolveRead = resolve))
    const oldRead = state.refreshLogs()
    const sameRead = state.refreshLogs()
    expect(sameRead).toBe(oldRead)
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 200 }))
    await state.clearLogs()
    resolveRead(new Response(JSON.stringify([{ id: 'old-traffic' }])))
    await oldRead
    expect(state.logs.value).toEqual([])
    expect(state.logsError.value).toBeNull()
  })

  it.each([401, 403])('reports HTTP %i as a denied state and clears previously visible private data', async (status) => {
    const state = useSharedODataState()
    state.config.value = { basePath: '/api/odx', services: [{ name: 'Northwind' }] }
    state.selectedService.value = { name: 'Northwind', route: 'northwind' } as any
    state.sessionHeaders.value = { Authorization: 'synthetic-session' }
    state.logs.value = [{ id: 'private-old-traffic' }] as any
    vi.mocked(fetch).mockResolvedValue(new Response('', { status }))
    await state.fetchConfig()
    await state.refreshLogs()
    await nextTick()
    expect(state.configError.value).toContain(`HTTP ${status}`)
    expect(state.logsError.value).toContain(`HTTP ${status}`)
    expect(state.selectedService.value).toBeNull()
    expect(state.sessionHeaders.value).toEqual({})
    expect(state.logs.value).toEqual([])
    vi.mocked(fetch).mockResolvedValue(new Response('[]'))
    await state.refreshLogs()
    expect(state.logsError.value).toBeNull()
  })

  it('reports failed log deletion and retains the existing history', async () => {
    const state = useSharedODataState()
    state.logs.value = [{ id: 'retained-traffic' }] as any
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 403 }))
    await expect(state.clearLogs()).rejects.toThrow('HTTP 403')
    expect(state.logs.value).toEqual([{ id: 'retained-traffic' }])
    expect(state.logsError.value).toContain('HTTP 403')
  })

  it('prepares an immutable non-GET request without dispatching it before review', async () => {
    const state = useSharedODataState()
    const service = { name: 'Northwind', route: 'northwind', strategy: 'proxied', entities: [{ name: 'Products' }, { name: 'Suppliers' }] }
    state.config.value = { basePath: '/api/odx', services: [service] }
    state.selectedService.value = service as any
    state.selectedEntity.value = 'Products'
    await nextTick()
    const explorer = createEntityExplorer()
    state.queryMethod.value = 'POST'
    state.queryInput.value = '?$select=ID'
    state.sessionHeaders.value = { 'X-Session': 'original' }
    vi.mocked(fetch).mockClear()
    await explorer.refreshEntityData()
    expect(fetch).not.toHaveBeenCalled()
    const target = explorer.editor.value.requestTarget
    state.selectedEntity.value = 'Suppliers'
    state.queryInput.value = '?$top=1'
    state.queryMethod.value = 'DELETE'
    state.sessionHeaders.value = { 'X-Session': 'changed' }
    expect(explorer.editor.value).toMatchObject({
      show: true,
      mode: 'request',
      context: 'POST /api/odx/northwind/Products?$select=ID',
      json: '{}',
      requestTarget: { method: 'POST', url: '/api/odx/northwind/Products?$select=ID', headers: { 'X-Session': 'original' } },
    })
    expect(Object.isFrozen(target)).toBe(true)
    expect(Object.isFrozen(target?.headers)).toBe(true)
    expect(state.entityDataCache.value[buildEntityPreviewCacheKey('Northwind', 'Suppliers')]).toBeUndefined()
  })

  it('keeps raw writes on the host proxy when direct reads have opted out of the bridge', async () => {
    const state = useSharedODataState()
    const service = { name: 'Northwind', route: 'northwind', strategy: 'direct', url: 'https://synthetic.invalid/odata', entities: [{ name: 'Products' }] }
    state.config.value = { basePath: '/api/odx', services: [service] }
    state.selectedService.value = service as any
    state.selectedEntity.value = 'Products'
    const explorer = createEntityExplorer()
    await nextTick()
    await nextTick()
    state.useCORSBridge.value = false
    state.queryMethod.value = 'PATCH'
    vi.mocked(fetch).mockClear()
    await explorer.refreshEntityData()
    expect(fetch).not.toHaveBeenCalled()
    expect(explorer.editor.value.requestTarget?.url).toBe('/api/odx/northwind/Products')
  })

  it('clears server and local traffic logs', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({ ok: true })

    const { clearLogs, logs } = useSharedODataState()
    logs.value = [{ id: '1', method: 'GET', url: '/t', service: 'S' } as any]

    await clearLogs()

    expect(globalThis.fetch).toHaveBeenCalledWith('/__odx__/logs', { method: 'DELETE', signal: expect.any(AbortSignal) })
    expect(logs.value).toEqual([])
  })

  it('encodes service names when checking service health and refreshing service metadata', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ services: [{ name: 'R&D #1?', route: 'rd' }] }),
    })

    const { fetchConfig, refreshServiceMetadata } = useSharedODataState()
    await fetchConfig()
    await nextTick()

    expect(globalThis.fetch).toHaveBeenCalledWith('/__odx__/schema?service=R%26D%20%231%3F', { signal: expect.any(AbortSignal) })

    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })

    await refreshServiceMetadata('R&D #1?')

    expect(globalThis.fetch).toHaveBeenCalledWith('/__odx__/generate?service=R%26D%20%231%3F')
  })

  it('does not expose mock-data deletion as an Explorer state action', () => {
    expect(useSharedODataState()).not.toHaveProperty('clearEntityMockData')
    expect(createEntityExplorer()).not.toHaveProperty('clearData')
  })

  it('builds raw metadata URLs with encoded service names and raw=true preserved', () => {
    expect(buildSchemaEndpointUrl('R&D #1?', { raw: true })).toBe('/__odx__/schema?service=R%26D%20%231%3F&raw=true')
  })

  it('prefixes ODX API and proxied runtime URLs with a configured standalone API origin', () => {
    const previousRuntimeConfig = (globalThis as any).useRuntimeConfig
    ;(globalThis as any).useRuntimeConfig = () => ({
      public: { odxApiBase: 'https://proxy.example.test/__odx__/' },
    })

    try {
      expect(buildOdxApiEndpoint('/__odx__/config')).toBe('https://proxy.example.test/__odx__/config')
      expect(buildSchemaEndpointUrl('R&D #1?')).toBe('https://proxy.example.test/__odx__/schema?service=R%26D%20%231%3F')
      expect(buildRuntimeProxyUrl('/api/odx/northwind/Products')).toBe('https://proxy.example.test/api/odx/northwind/Products')
    }
    finally {
      if (previousRuntimeConfig)
        (globalThis as any).useRuntimeConfig = previousRuntimeConfig
      else
        delete (globalThis as any).useRuntimeConfig
    }
  })

  it.each(['/console', '/console/__odx__/', 'https://proxy.example.test/console/__odx__', '//proxy.example.test/console/__odx__/'])('keeps the host base for embedded API and proxy requests: %s', (base) => {
    const previousRuntimeConfig = (globalThis as any).useRuntimeConfig
    ;(globalThis as any).useRuntimeConfig = () => ({ public: { odxApiBase: base } })
    try {
      const expected = base.startsWith('https:') ? 'https://proxy.example.test/console' : base.startsWith('//') ? '//proxy.example.test/console' : '/console'
      expect(buildSchemaEndpointUrl('Catalog')).toBe(`${expected}/__odx__/schema?service=Catalog`)
      expect(buildRuntimeProxyUrl('/api/odx/catalog/Products')).toBe(`${expected}/api/odx/catalog/Products`)
    }
    finally {
      if (previousRuntimeConfig)
        (globalThis as any).useRuntimeConfig = previousRuntimeConfig
      else
        delete (globalThis as any).useRuntimeConfig
    }
  })

  it('returns metadata refresh results without requiring SDK generation semantics', async () => {
    ;(globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          operation: 'metadata-refresh',
          generated: false,
          stale: false,
          service: 'RemoteService',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          basePath: '/api/odx',
          services: [
            {
              name: 'RemoteService',
              route: 'remote',
              metadata: { status: 'available', stale: false },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entities: [],
          metadata: { status: 'available', stale: false },
        }),
      })

    const { refreshServiceMetadata, services } = useSharedODataState()
    const result = await refreshServiceMetadata('RemoteService')
    await nextTick()

    expect(result).toMatchObject({
      operation: 'metadata-refresh',
      generated: false,
    })
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, '/__odx__/generate?service=RemoteService')
    expect(services.value[0]?.metadata?.status).toBe('available')
  })

  it('uses development config capabilities to keep SDK generation affordances local', () => {
    const { config } = useSharedODataState()

    config.value = {
      basePath: '/api/odx',
      services: [],
      versions: { node: 'v24.0.0', module: '1.0.0' },
    }

    expect(supportsSdkGeneration(config.value)).toBe(true)

    config.value = {
      basePath: '/api/odx',
      services: [],
    }

    expect(supportsSdkGeneration(config.value)).toBe(false)
  })

  it('filters traffic logs by service, search text, and failure status', () => {
    const { config, filteredLogs, logFilterService, logFilterStatus, logSearch, logs } = useSharedODataState()
    config.value = {
      basePath: '/api/odx',
      services: [
        { name: 'Northwind', route: 'northwind' },
        { name: 'SAP', route: 'sap' },
      ],
    }
    logs.value = [
      {
        id: 'ok-products',
        timestamp: '2026-05-05T09:00:00.000Z',
        method: 'GET',
        service: 'Northwind',
        path: '/Products',
        entitySet: 'Products',
        status: 200,
        duration: 12,
        targetUrl: 'https://example.test/odata/Products',
      } as any,
      {
        id: 'failed-orders',
        timestamp: '2026-05-05T09:01:00.000Z',
        method: 'PATCH',
        service: 'Northwind',
        path: '/Orders(1)',
        entitySet: 'Orders',
        status: 500,
        duration: 31,
        targetUrl: 'https://example.test/odata/Orders(1)',
      } as any,
      {
        id: 'sap-business-partners',
        timestamp: '2026-05-05T09:02:00.000Z',
        method: 'GET',
        service: 'SAP',
        path: '/BusinessPartner',
        entitySet: 'BusinessPartner',
        status: 404,
        duration: 20,
        targetUrl: 'https://sap.test/BusinessPartner',
      } as any,
    ]

    logFilterService.value = 'northwind'
    logFilterStatus.value = 'failures'
    logSearch.value = 'orders patch'

    expect(filteredLogs.value.map(log => log.id)).toEqual(['failed-orders'])
  })

  it('filters traffic logs to non-failures and matches service route aliases', () => {
    const { config, filteredLogs, logFilterService, logFilterStatus, logSearch, logs } = useSharedODataState()
    config.value = {
      basePath: '/api/odx',
      services: [{ name: 'Northwind', route: 'northwind-api' }],
    }
    logs.value = [
      {
        id: 'ok-products',
        timestamp: '2026-05-05T09:00:00.000Z',
        method: 'GET',
        service: 'Northwind',
        path: '/Products',
        entitySet: 'Products',
        status: 204,
        duration: 12,
      } as any,
      {
        id: 'failed-products',
        timestamp: '2026-05-05T09:01:00.000Z',
        method: 'DELETE',
        service: 'Northwind',
        path: '/Products(1)',
        entitySet: 'Products',
        status: 403,
        duration: 18,
      } as any,
    ]

    logFilterService.value = 'northwind-api'
    logFilterStatus.value = 'success'
    logSearch.value = 'products'

    expect(filteredLogs.value.map(log => log.id)).toEqual(['ok-products'])
  })

  it('keeps pending traffic visible only in the all status filter', () => {
    const { filteredLogs, logFilterStatus, logs } = useSharedODataState()
    logs.value = [
      {
        id: 'pending-products',
        timestamp: '2026-05-05T09:00:00.000Z',
        method: 'GET',
        service: 'Northwind',
        path: '/Products',
        entitySet: 'Products',
        status: undefined,
        duration: 0,
        isPending: true,
      } as any,
      {
        id: 'ok-products',
        timestamp: '2026-05-05T09:01:00.000Z',
        method: 'GET',
        service: 'Northwind',
        path: '/Products',
        entitySet: 'Products',
        status: 200,
        duration: 12,
      } as any,
      {
        id: 'failed-products',
        timestamp: '2026-05-05T09:02:00.000Z',
        method: 'GET',
        service: 'Northwind',
        path: '/Products',
        entitySet: 'Products',
        status: 500,
        duration: 16,
      } as any,
    ]

    logFilterStatus.value = 'all'
    expect(filteredLogs.value.map(log => log.id)).toEqual(['pending-products', 'ok-products', 'failed-products'])

    logFilterStatus.value = 'success'
    expect(filteredLogs.value.map(log => log.id)).toEqual(['ok-products'])

    logFilterStatus.value = 'failures'
    expect(filteredLogs.value.map(log => log.id)).toEqual(['failed-products'])
  })

  it('detects when active traffic filters hide existing logs', () => {
    const { filteredLogs, hasActiveLogFilters, hasFilteredOutLogs, logFilterStatus, logs } = useSharedODataState()
    logs.value = [
      {
        id: 'ok-products',
        timestamp: '2026-05-05T09:00:00.000Z',
        method: 'GET',
        service: 'Northwind',
        path: '/Products',
        entitySet: 'Products',
        status: 200,
        duration: 12,
      } as any,
    ]

    logFilterStatus.value = 'failures'

    expect(hasActiveLogFilters.value).toBe(true)
    expect(filteredLogs.value).toEqual([])
    expect(hasFilteredOutLogs.value).toBe(true)
  })

  it('clears all traffic log filters together', () => {
    const { clearLogFilters, hasActiveLogFilters, logFilterService, logFilterStatus, logSearch } = useSharedODataState()
    logFilterService.value = 'northwind'
    logFilterStatus.value = 'failures'
    logSearch.value = 'orders'

    expect(hasActiveLogFilters.value).toBe(true)

    clearLogFilters()

    expect(logFilterService.value).toBeNull()
    expect(logFilterStatus.value).toBe('all')
    expect(logSearch.value).toBe('')
    expect(hasActiveLogFilters.value).toBe(false)
  })

  it('preserves traffic log service filter when refreshed config still contains the service name', async () => {
    const { config, logFilterService, logFilterStatus, logSearch, logs, selectedTraceLogId } = useSharedODataState()
    logs.value = [
      {
        id: 'trace-1',
        timestamp: '2026-05-05T09:00:00.000Z',
        method: 'GET',
        service: 'Northwind',
        path: '/Products',
        status: 200,
        duration: 12,
        proxyTrace: [{ label: 'Proxy', duration: 1 }],
      } as any,
    ]
    logFilterService.value = 'Northwind'
    logFilterStatus.value = 'success'
    logSearch.value = 'products'
    selectedTraceLogId.value = 'trace-1'

    config.value = {
      basePath: '/api/odx',
      services: [{ name: 'Northwind', route: 'renamed-northwind' }],
    }
    await nextTick()

    expect(logFilterService.value).toBe('Northwind')
    expect(logFilterStatus.value).toBe('success')
    expect(logSearch.value).toBe('products')
    expect(selectedTraceLogId.value).toBe('trace-1')
    expect(logs.value.map(log => log.id)).toEqual(['trace-1'])
  })

  it('preserves traffic log service filter when refreshed config still contains the route alias', async () => {
    const { config, logFilterService, logFilterStatus, logSearch, logs, selectedTraceLogId } = useSharedODataState()
    logs.value = [
      {
        id: 'trace-1',
        timestamp: '2026-05-05T09:00:00.000Z',
        method: 'GET',
        service: 'Northwind',
        path: '/Products',
        status: 200,
        duration: 12,
        proxyTrace: [{ label: 'Proxy', duration: 1 }],
      } as any,
    ]
    logFilterService.value = 'northwind-api'
    logFilterStatus.value = 'success'
    logSearch.value = 'products'
    selectedTraceLogId.value = 'trace-1'

    config.value = {
      basePath: '/api/odx',
      services: [{ name: 'RenamedNorthwind', route: 'northwind-api' }],
    }
    await nextTick()

    expect(logFilterService.value).toBe('northwind-api')
    expect(logFilterStatus.value).toBe('success')
    expect(logSearch.value).toBe('products')
    expect(selectedTraceLogId.value).toBe('trace-1')
    expect(logs.value.map(log => log.id)).toEqual(['trace-1'])
  })

  it('clears only stale traffic log service filter after config refresh', async () => {
    const {
      config,
      logFilterService,
      logFilterStatus,
      logSearch,
      logs,
      selectedEntity,
      selectedService,
      selectedTraceLogId,
    } = useSharedODataState()
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ entities: [] }),
    })
    logs.value = [
      {
        id: 'trace-1',
        timestamp: '2026-05-05T09:00:00.000Z',
        method: 'GET',
        service: 'Northwind',
        path: '/Products',
        status: 200,
        duration: 12,
        proxyTrace: [{ label: 'Proxy', duration: 1 }],
      } as any,
    ]
    selectedService.value = {
      name: 'SAP',
      route: 'sap',
      entities: [{ name: 'BusinessPartner', entitySet: 'BusinessPartners' }],
    } as any
    selectedEntity.value = 'BusinessPartners'
    logFilterService.value = 'old-northwind'
    logFilterStatus.value = 'success'
    logSearch.value = 'products'
    selectedTraceLogId.value = 'trace-1'

    config.value = {
      basePath: '/api/odx',
      services: [
        {
          name: 'SAP',
          route: 'sap',
          entities: [{ name: 'BusinessPartner', entitySet: 'BusinessPartners' }],
        },
      ],
    }
    await nextTick()

    expect(logFilterService.value).toBeNull()
    expect(logFilterStatus.value).toBe('success')
    expect(logSearch.value).toBe('products')
    expect(selectedTraceLogId.value).toBe('trace-1')
    expect(selectedService.value?.name).toBe('SAP')
    expect(selectedEntity.value).toBe('BusinessPartners')
    expect(logs.value.map(log => log.id)).toEqual(['trace-1'])
  })

  it('coordinates selected proxy trace log state', () => {
    const { activeTab, logs, selectedTraceLogId } = useSharedODataState()
    logs.value = [
      {
        id: 'trace-1',
        method: 'GET',
        url: '/api/odx/S/Products',
        service: 'S',
        proxyTrace: [{ label: 'Proxy', duration: 1 }],
      } as any,
    ]

    selectedTraceLogId.value = 'trace-1'
    activeTab.value = 'proxy'

    expect(selectedTraceLogId.value).toBe('trace-1')
    expect(activeTab.value).toBe('proxy')
    expect(logs.value[0]?.proxyTrace).toHaveLength(1)
  })

  it('preserves selected proxy trace when refreshed logs still contain it', async () => {
    const refreshedLogs = [
      {
        id: 'trace-1',
        method: 'GET',
        url: '/api/odx/S/Products',
        service: 'S',
        proxyTrace: [{ label: 'Proxy', duration: 1 }],
      },
      {
        id: 'trace-2',
        method: 'GET',
        url: '/api/odx/S/Orders',
        service: 'S',
        proxyTrace: [{ label: 'Proxy', duration: 2 }],
      },
    ] as any[]
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => refreshedLogs,
    })
    const { refreshLogs, selectedTraceLogId } = useSharedODataState()
    selectedTraceLogId.value = 'trace-1'

    await refreshLogs()

    expect(selectedTraceLogId.value).toBe('trace-1')
  })

  it('clears selected proxy trace when refreshed logs no longer contain it', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'trace-2',
          method: 'GET',
          url: '/api/odx/S/Orders',
          service: 'S',
          proxyTrace: [{ label: 'Proxy', duration: 2 }],
        },
      ],
    })
    const { refreshLogs, selectedTraceLogId } = useSharedODataState()
    selectedTraceLogId.value = 'trace-1'

    await refreshLogs()

    expect(selectedTraceLogId.value).toBeNull()
  })

  it('clears selected proxy trace when traffic logs are cleared', async () => {
    ;(globalThis.fetch as any).mockResolvedValue({ ok: true })
    const { clearLogs, logs, selectedTraceLogId } = useSharedODataState()
    logs.value = [
      {
        id: 'trace-1',
        method: 'GET',
        url: '/api/odx/S/Products',
        service: 'S',
        proxyTrace: [{ label: 'Proxy', duration: 1 }],
      },
    ] as any[]
    selectedTraceLogId.value = 'trace-1'

    await clearLogs()

    expect(logs.value).toEqual([])
    expect(selectedTraceLogId.value).toBeNull()
  })

  it('keeps degraded service health until a forced online update', () => {
    const { config, services, updateServiceHealth } = useSharedODataState()
    config.value = {
      basePath: '/api/odx',
      services: [{ name: 'Northwind', route: 'northwind' }],
    }

    updateServiceHealth('Northwind', 'degraded')
    updateServiceHealth('Northwind', 'online')

    expect(services.value[0]?.health).toBe('degraded')

    updateServiceHealth('Northwind', 'online', true)

    expect(services.value[0]?.health).toBe('online')
  })

  it('maps missing metadata from config to offline health before background checks finish', () => {
    const { config, services } = useSharedODataState()
    config.value = {
      basePath: '/api/odx',
      services: [
        {
          name: 'RemoteService',
          route: 'remote',
          metadata: { status: 'missing', stale: false, staleReason: null },
        },
      ],
    }

    expect(services.value[0]?.health).toBe('offline')
  })

  it('maps stale metadata from config to degraded health before background checks finish', () => {
    const { config, services } = useSharedODataState()
    config.value = {
      basePath: '/api/odx',
      services: [
        {
          name: 'RemoteService',
          route: 'remote',
          metadata: { status: 'stale', stale: true, staleReason: 'Status: 503' },
        },
      ],
    }

    expect(services.value[0]?.health).toBe('degraded')
  })

  it('marks service health as degraded when schema health check reports stale metadata', async () => {
    ;(globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          basePath: '/api/odx',
          services: [{ name: 'RemoteService', route: 'remote' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entities: [],
          metadata: { status: 'stale', stale: true, staleReason: 'Status: 503' },
        }),
      })

    const { fetchConfig, services } = useSharedODataState()
    await fetchConfig()
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(globalThis.fetch).toHaveBeenCalledWith('/__odx__/schema?service=RemoteService', { signal: expect.any(AbortSignal) })
    expect(services.value[0]?.health).toBe('degraded')
  })

  it('maps configured services with default and overridden health states', () => {
    const { config, services, updateServiceHealth } = useSharedODataState()
    config.value = {
      basePath: '/api/odx',
      services: [
        { name: 'Northwind', route: 'northwind' },
        { name: 'SAP', route: 'sap', health: 'online' },
      ],
    }

    expect(services.value.map(s => [s.name, s.health])).toEqual([
      ['Northwind', 'checking'],
      ['SAP', 'checking'],
    ])

    updateServiceHealth('Northwind', 'offline')
    updateServiceHealth('SAP', 'online')

    expect(services.value.map(s => [s.name, s.health])).toEqual([
      ['Northwind', 'offline'],
      ['SAP', 'online'],
    ])
  })

  it('accepts sanitized production service config without secret-bearing fields', () => {
    const { config, services } = useSharedODataState()
    config.value = {
      basePath: '/api/odx',
      services: [
        {
          name: 'Northwind',
          route: 'northwind',
          strategy: 'proxied',
          entities: [{ name: 'Product', type: 'Product', properties: [], navigationProperties: [] }],
          isGenerated: false,
          version: 'v2',
        },
      ],
    }

    expect(services.value[0]).toMatchObject({
      name: 'Northwind',
      route: 'northwind',
      strategy: 'proxied',
      health: 'checking',
      entities: [{ name: 'Product' }],
      isGenerated: false,
      version: 'v2',
    })
    expect(services.value[0]?.url).toBeUndefined()
    expect(services.value[0]?.headers).toBeUndefined()
    expect(services.value[0]?.config).toBeUndefined()
  })

  it('preserves selected entity when refreshed config still contains it', async () => {
    const { config, selectedEntity, selectedService } = useSharedODataState()
    selectedService.value = {
      name: 'Northwind',
      route: 'northwind',
      entities: [{ name: 'Product', entitySet: 'Products' }],
    } as any
    selectedEntity.value = 'Products'

    config.value = {
      basePath: '/api/odx',
      services: [
        {
          name: 'Northwind',
          route: 'northwind',
          entities: [
            { name: 'Product', entitySet: 'Products' },
            { name: 'Order', entitySet: 'Orders' },
          ],
        },
      ],
    }
    await nextTick()

    expect(selectedService.value?.name).toBe('Northwind')
    expect(selectedEntity.value).toBe('Products')
  })

  it('clears stale selected entity when refreshed config no longer contains it', async () => {
    const { config, previewData, queryInput, queryMethod, selectedEntity, selectedService } = useSharedODataState()
    selectedService.value = {
      name: 'Northwind',
      route: 'northwind',
      entities: [{ name: 'Product', entitySet: 'Products' }],
    } as any
    selectedEntity.value = 'Products'
    previewData.value = [{ ID: 1 }]
    queryInput.value = '?$top=1'
    queryMethod.value = 'POST'

    config.value = {
      basePath: '/api/odx',
      services: [
        {
          name: 'Northwind',
          route: 'northwind',
          entities: [{ name: 'Order', entitySet: 'Orders' }],
        },
      ],
    }
    await nextTick()

    expect(selectedService.value?.name).toBe('Northwind')
    expect(selectedEntity.value).toBeNull()
    expect(previewData.value).toBeNull()
    expect(queryInput.value).toBe('?')
    expect(queryMethod.value).toBe('GET')
  })

  it('clears selected service and entity when refreshed config removes the service', async () => {
    const { config, previewData, selectedEntity, selectedService } = useSharedODataState()
    selectedService.value = {
      name: 'Northwind',
      route: 'northwind',
      entities: [{ name: 'Product', entitySet: 'Products' }],
    } as any
    selectedEntity.value = 'Products'
    previewData.value = [{ ID: 1 }]

    config.value = {
      basePath: '/api/odx',
      services: [
        {
          name: 'SAP',
          route: 'sap',
          entities: [{ name: 'BusinessPartner', entitySet: 'BusinessPartners' }],
        },
      ],
    }
    await nextTick()

    expect(selectedService.value).toBeNull()
    expect(selectedEntity.value).toBeNull()
    expect(previewData.value).toBeNull()
  })

  it('serializes visual query state into an OData query string', async () => {
    const { queryInput, queryState } = createEntityExplorer()

    queryState.value = {
      filters: {
        type: 'group',
        logic: 'and',
        items: [
          { type: 'rule', field: 'Name', operator: 'contains', value: 'Tea' },
          { type: 'rule', field: 'Price', operator: 'gt', value: 10 },
        ],
      },
      select: ['ID', 'Name'],
      expand: ['Category'],
      sortBy: [{ field: 'Name', direction: 'asc' }],
      top: 5,
      skip: 10,
    }
    await nextTick()

    expect(queryInput.value).toBe('?$select=ID,Name&$expand=Category&$filter=contains(Name,\'Tea\') and Price gt 10&$orderby=Name asc&$top=5&$skip=10')
  })

  it('escapes single quotes in visual query builder string filters', async () => {
    const { queryInput, queryState } = createEntityExplorer()

    queryState.value = {
      filters: {
        type: 'group',
        logic: 'and',
        items: [
          { type: 'rule', field: 'Name', operator: 'eq', value: 'Bob\'s Tea' },
        ],
      },
      select: [],
      expand: [],
      sortBy: [],
      top: null,
      skip: null,
    }
    await nextTick()

    expect(queryInput.value).toBe('?$filter=Name eq \'Bob\'\'s Tea\'')
  })

  it('escapes string values in visual query builder function filters', async () => {
    const { queryInput, queryState } = createEntityExplorer()

    queryState.value = {
      filters: {
        type: 'group',
        logic: 'and',
        items: [
          { type: 'rule', field: 'Name', operator: 'contains', value: 'Bob\'s' },
        ],
      },
      select: [],
      expand: [],
      sortBy: [],
      top: null,
      skip: null,
    }
    await nextTick()

    expect(queryInput.value).toBe('?$filter=contains(Name,\'Bob\'\'s\')')
  })

  it('encodes ampersands inside visual query builder string filters so they are not parsed as query separators', async () => {
    const { queryInput, queryState } = createEntityExplorer()

    queryState.value = {
      filters: {
        type: 'group',
        logic: 'and',
        items: [
          { type: 'rule', field: 'Name', operator: 'eq', value: 'R&D' },
        ],
      },
      select: [],
      expand: [],
      sortBy: [],
      top: null,
      skip: null,
    }
    await nextTick()

    expect(queryInput.value).toBe('?$filter=Name eq \'R%26D\'')
  })

  it('serializes numeric visual query builder values without string quotes', async () => {
    const { entitySchema, queryInput, selectedEntity, selectedService } = useSharedODataState()
    const schema = {
      entities: [
        {
          name: 'Product',
          entitySet: 'Products',
          properties: [{ name: 'Price', type: 'Edm.Decimal' }],
        },
      ],
    }
    selectedService.value = {
      name: 'Northwind',
      route: 'northwind',
      strategy: 'proxied',
    } as any
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => schema,
    })
    selectedEntity.value = 'Products'
    await nextTick()
    await nextTick()
    entitySchema.value = schema
    const explorer = createEntityExplorer()

    explorer.queryState.value = {
      filters: {
        type: 'group',
        logic: 'and',
        items: [
          { type: 'rule', field: 'Price', operator: 'ge', value: '12.5' },
        ],
      },
      select: [],
      expand: [],
      sortBy: [],
      top: 25,
      skip: 50,
    }
    await nextTick()

    expect(queryInput.value).toBe('?$filter=Price ge 12.5&$top=25&$skip=50')
  })

  it('resets visual query state back to the entity browser default', async () => {
    const { queryInput, queryState, resetQuery } = createEntityExplorer()
    queryState.value = {
      filters: {
        type: 'group',
        logic: 'or',
        items: [{ type: 'rule', field: 'Name', operator: 'eq', value: 'Tea' }],
      },
      select: ['ID'],
      expand: ['Category'],
      sortBy: [{ field: 'Name', direction: 'desc' }],
      top: 1,
      skip: 2,
    }
    await nextTick()

    resetQuery()

    expect(queryInput.value).toBe('?')
    expect(queryState.value).toEqual({
      filters: {
        type: 'group',
        logic: 'and',
        items: [],
      },
      select: [],
      expand: [],
      sortBy: [],
      top: null,
      skip: null,
    })
  })

  it('fetches entity data through the proxied route and caches the query state', async () => {
    const { config, entityDataCache, queryInput, queryState, selectedEntity, selectedService, sessionHeaders } = useSharedODataState()
    config.value = {
      basePath: '/api/odx',
      services: [
        {
          name: 'Northwind',
          route: 'northwind',
          strategy: 'proxied',
          entities: [{ name: 'Product', entitySet: 'Products' }],
        },
      ],
    }
    ;(globalThis.fetch as any).mockImplementation(async (url: string) => {
      if (url === '/__odx__/schema?service=Northwind') {
        return {
          ok: true,
          json: async () => ({ entities: [] }),
        }
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ value: [{ ID: 1, Name: 'Tea' }] }),
      }
    })
    selectedService.value = {
      name: 'Northwind',
      route: 'northwind',
      strategy: 'proxied',
    } as any
    selectedEntity.value = 'Products'
    await nextTick()
    queryInput.value = '?$top=1'
    queryState.value = {
      filters: { type: 'group', logic: 'and', items: [] },
      select: ['ID'],
      expand: [],
      sortBy: [],
      top: 1,
      skip: null,
    }
    await nextTick()
    sessionHeaders.value = { 'x-session': 'abc' }

    const { previewData, refreshEntityData } = createEntityExplorer()
    await refreshEntityData()

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/odx/northwind/Products?$select=ID&$top=1', {
      method: 'GET',
      signal: expect.any(AbortSignal),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-session': 'abc',
      },
    })
    expect(previewData.value).toEqual([{ ID: 1, Name: 'Tea' }])
    expect(entityDataCache.value[buildEntityPreviewCacheKey('Northwind', 'Products')]).toEqual({
      data: [{ ID: 1, Name: 'Tea' }],
      error: null,
      query: '?$select=ID&$top=1',
      method: 'GET',
      queryState: {
        filters: { type: 'group', logic: 'and', items: [] },
        select: ['ID'],
        expand: [],
        sortBy: [],
        top: 1,
        skip: null,
      },
    })
  })

  it('keeps session overrides service-owned and excludes configured outbound headers from the editor', async () => {
    const state = useSharedODataState()
    const service = { name: 'Northwind', headers: { 'X-Server-Only': 'synthetic-private' }, entities: [{ name: 'Products' }] }
    state.config.value = { basePath: '/api/odx', services: [service, { name: 'Other' }] }
    state.selectedService.value = service as any
    state.selectedEntity.value = 'Products'
    const explorer = createEntityExplorer()
    state.sessionHeaders.value = { 'sap-client': '100' }
    explorer.openEditor('headers')
    expect(explorer.editor.value.headersServiceName).toBe('Northwind')
    expect(JSON.parse(explorer.editor.value.json)).toEqual({ 'sap-client': '100' })
    state.selectedService.value = { name: 'Other' } as any
    expect(state.sessionHeaders.value).toEqual({})
    state.setSessionHeaders('Northwind', { 'sap-client': '200' })
    expect(state.sessionHeaders.value).toEqual({})
    state.sessionHeaders.value = { 'sap-client': '300' }
    state.selectedService.value = service as any
    expect(state.sessionHeaders.value).toEqual({ 'sap-client': '200' })
    state.clearSessionHeaders()
    expect(state.getSessionHeaders('Other')).toEqual({})
  })

  it('requests exact IEEE754 JSON values for reads with owned V4 metadata', async () => {
    const state = useSharedODataState()
    const service = { name: 'Northwind', route: 'northwind', entities: [{ name: 'Products' }] }
    state.config.value = { basePath: '/api/odx', services: [service] }
    state.selectedService.value = service as any
    state.selectedEntity.value = 'Products'
    const explorer = createEntityExplorer()
    await nextTick()
    await nextTick()
    state.entitySchema.value = { name: 'Northwind', version: 'v4', entities: [] }
    state.sessionHeaders.value = { 'accept': 'text/xml', 'CONTENT-TYPE': 'text/plain', 'X-Session': 'synthetic' }
    await explorer.reloadEntityData()
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).toEqual({ 'Accept': 'application/json;IEEE754Compatible=true', 'Content-Type': 'application/json;IEEE754Compatible=true', 'X-Session': 'synthetic' })
  })

  it('captures the original editor target, method and headers before selection changes', async () => {
    const state = useSharedODataState()
    const service = { name: 'Northwind', route: 'northwind', entities: [{ name: 'Products' }] }
    state.config.value = { basePath: '/api/odx', services: [service] }
    state.selectedService.value = service as any
    state.selectedEntity.value = 'Products'
    const explorer = createEntityExplorer()
    await nextTick()
    await nextTick()
    state.entitySchema.value = { name: 'Northwind', version: 'v2', entities: [{ name: 'Products', properties: [{ name: 'Code', type: 'Edm.String', isKey: true }] }] }
    state.sessionHeaders.value = { 'X-Test-Session': 'original' }
    const row = { 'Code': 'A/B', 'ID': 999, '@odata.etag': 'W/"captured"' }
    state.previewData.value = [row]
    state.previewOwner.value = { serviceName: 'Northwind', entitySet: 'Products' }
    explorer.openEditor('update', row)
    const target = explorer.editor.value.target
    row.Code = 'changed'
    row['@odata.etag'] = 'W/"later"'
    state.selectedService.value = { name: 'Other', route: 'other' } as any
    state.selectedEntity.value = 'Suppliers'
    state.sessionHeaders.value = { 'X-Test-Session': 'replacement' }
    expect(target, explorer.editor.value.targetError).toEqual({
      serviceName: 'Northwind',
      entitySet: 'Products',
      url: '/api/odx/northwind/Products(\'A%2FB\')',
      method: 'MERGE',
      headers: { 'X-Test-Session': 'original', 'If-Match': 'W/"captured"', 'Accept': 'application/json', 'Content-Type': 'application/json' },
      etag: 'W/"captured"',
      key: { 'version': 'v2', '@odata.key': [{ field: 'Code', type: 'Edm.String', value: 'A/B' }] },
      originalJson: JSON.stringify({ 'Code': 'A/B', 'ID': 999, '@odata.etag': 'W/"captured"' }),
      navigationProperties: [],
    })
    expect(Object.isFrozen(target)).toBe(true)
    expect(Object.isFrozen(target?.headers)).toBe(true)
  })

  it('rejects a previous entity row before the selection watcher has flushed', async () => {
    const state = useSharedODataState()
    const service = { name: 'Northwind', route: 'northwind', entities: [{ name: 'Products' }, { name: 'Suppliers' }] }
    state.config.value = { basePath: '/api/odx', services: [service] }
    state.selectedService.value = service as any
    state.selectedEntity.value = 'Products'
    const explorer = createEntityExplorer()
    await nextTick()
    await nextTick()
    const properties = [{ name: 'ID', type: 'Edm.Int32', isKey: true }]
    state.entitySchema.value = { name: 'Northwind', version: 'v4', entities: [{ name: 'Products', properties }, { name: 'Suppliers', properties }] }
    const row = { ID: 0 }
    state.previewData.value = [row]
    state.previewOwner.value = { serviceName: 'Northwind', entitySet: 'Products' }
    state.selectedEntity.value = 'Suppliers'
    explorer.openEditor('update', row)
    expect(explorer.editor.value.target).toBeUndefined()
    expect(explorer.editor.value.targetError).toContain('does not belong to the displayed service and entity')
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it.each([
    { id: 'A/B?x=1&R #2', type: 'Edm.String', path: 'Products(\'A%2FB%3Fx%3D1%26R%20%232\')' },
    { id: 0, type: 'Edm.Int32', path: 'Products(0)' },
  ])('uses the declared delete key $id while preserving delete success behavior', async ({ id, type, path }) => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const { config, previewData, previewOwner, queryMethod, selectedEntity, selectedService, entitySchema } = useSharedODataState()
    const metadata = { name: 'Northwind', version: 'v4', entities: [{ name: 'Products', properties: [{ name: 'ProductCode', type, isKey: true }] }] }
    config.value = {
      basePath: '/api/odx',
      services: [
        {
          name: 'Northwind',
          route: 'northwind-api',
          strategy: 'proxied',
          entities: [{ name: 'Product', entitySet: 'Products' }],
        },
      ],
    }
    selectedService.value = {
      name: 'Northwind',
      route: 'northwind-api',
      strategy: 'proxied',
    } as any
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => metadata,
    })
    selectedEntity.value = 'Products'
    await nextTick()
    await nextTick()
    entitySchema.value = metadata
    const row = { ProductCode: id, ID: 999 }
    previewData.value = [row]
    previewOwner.value = { serviceName: 'Northwind', entitySet: 'Products' }
    queryMethod.value = 'DELETE'

    ;(globalThis.fetch as any).mockClear()
    ;(globalThis.fetch as any)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ value: [{ ID: 'refreshed' }] }),
      })

    const { deleteItem } = createEntityExplorer()
    const nuxtApp = useNuxtApp()
    await nuxtApp.runWithContext(() => deleteItem(row))
    await nextTick()

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      `/api/odx/northwind-api/${path}`,
      { method: 'DELETE', headers: { 'Accept': 'application/json;IEEE754Compatible=true', 'Content-Type': 'application/json;IEEE754Compatible=true' } },
    )
    expect(nuxtApp.payload.state.$stoasts).toEqual(expect.arrayContaining([expect.objectContaining({
      title: 'Record deleted from Products',
      icon: 'i-lucide-circle-check',
      color: 'success',
    })]))
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, '/api/odx/northwind-api/Products', {
      method: 'GET',
      signal: expect.any(AbortSignal),
      headers: {
        'Accept': 'application/json;IEEE754Compatible=true',
        'Content-Type': 'application/json;IEEE754Compatible=true',
      },
    })
    expect(previewData.value).toEqual([{ ID: 'refreshed' }])
    expect(queryMethod.value).toBe('DELETE')
  })

  it('reports failed deletes without refreshing or claiming success', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const { config, selectedEntity, selectedService, sessionHeaders, entitySchema, previewData, previewOwner } = useSharedODataState()
    const service = { name: 'Northwind', route: 'northwind', entities: [{ name: 'Products' }] }
    config.value = { basePath: '/api/odx', services: [service] }
    selectedService.value = service as any
    selectedEntity.value = 'Products'
    await nextTick()
    await nextTick()
    entitySchema.value = { name: 'Northwind', version: 'v4', entities: [{ name: 'Products', properties: [{ name: 'ID', type: 'Edm.Int32', isKey: true }] }] }
    const row = { ID: 0 }
    previewData.value = [row]
    previewOwner.value = { serviceName: 'Northwind', entitySet: 'Products' }
    sessionHeaders.value = { 'X-Test-Session': 'synthetic' }
    vi.mocked(globalThis.fetch).mockClear()
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 412, statusText: 'Precondition Failed' }))
    await createEntityExplorer().deleteItem(row)
    await nextTick()
    expect(globalThis.fetch).toHaveBeenCalledExactlyOnceWith('/api/odx/northwind/Products(0)', {
      method: 'DELETE',
      headers: { 'X-Test-Session': 'synthetic', 'Accept': 'application/json;IEEE754Compatible=true', 'Content-Type': 'application/json;IEEE754Compatible=true' },
    })
    expect(useNuxtApp().payload.state.$stoasts).toEqual(expect.arrayContaining([expect.objectContaining({
      color: 'error',
      title: expect.stringContaining('412'),
    })]))
  })

  it('restores cached entity preview state when reselecting an entity', async () => {
    const { entityDataCache, previewData, previewError, queryInput, queryMethod, queryState, selectedEntity, selectedService } = useSharedODataState()
    selectedService.value = { name: 'Northwind', route: 'northwind' } as any
    entityDataCache.value[buildEntityPreviewCacheKey('Northwind', 'Products')] = {
      data: [{ ID: 1, Name: 'Tea' }],
      error: null,
      query: '?$select=ID',
      method: 'GET',
      queryState: {
        filters: { type: 'group', logic: 'and', items: [] },
        select: ['ID'],
        expand: [],
        sortBy: [],
        top: null,
        skip: null,
      },
    }
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ entities: [] }),
    })

    selectedEntity.value = 'Products'
    await nextTick()
    await nextTick()

    expect(previewData.value).toEqual([{ ID: 1, Name: 'Tea' }])
    expect(previewError.value).toBeNull()
    expect(queryInput.value).toBe('?$select=ID')
    expect(queryMethod.value).toBe('GET')
    expect(queryState.value.select).toEqual(['ID'])
    expect(globalThis.fetch).toHaveBeenCalledWith('/__odx__/schema?service=Northwind', { signal: expect.any(AbortSignal) })
  })

  it('does not restore cached entity preview state for colliding service and entity names', async () => {
    const { entityDataCache, previewData, queryInput, queryState, selectedEntity, selectedService } = useSharedODataState()
    selectedService.value = { name: 'Northwind', route: 'northwind' } as any
    entityDataCache.value[buildEntityPreviewCacheKey('Northwind', 'Products:Variants')] = {
      data: [{ ID: 1, Name: 'Wrong cached item' }],
      error: null,
      query: '?$select=ID',
      method: 'GET',
      queryState: {
        filters: { type: 'group', logic: 'and', items: [] },
        select: ['ID'],
        expand: [],
        sortBy: [],
        top: null,
        skip: null,
      },
    }
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ entities: [] }),
    })

    selectedService.value = { name: 'Northwind:Products', route: 'northwind-products' } as any
    selectedEntity.value = 'Variants'
    await nextTick()
    await nextTick()

    expect(previewData.value).toBeNull()
    expect(queryInput.value).toBe('?')
    expect(queryState.value.select).toEqual([])
    expect(globalThis.fetch).toHaveBeenCalledWith('/__odx__/schema?service=Northwind%3AProducts', { signal: expect.any(AbortSignal) })
  })
})
