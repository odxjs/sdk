import type { ODataLog as CoreODataLog, ProxyTraceEntry as CoreProxyTraceEntry, EntityMapping, ODataServiceConfig } from '@me-tools/odx-core'
import type { ExplorerMutationTarget } from '../utils/recordIdentity'
import { useNuxtApp } from 'nuxt/app'
import { onScopeDispose } from 'vue'
import { createAppState } from '../utils/appState'
import { createLatestRequest } from '../utils/latestRequest'

const RE_ABSOLUTE_HTTP_URL = /^https?:\/\//i
const RE_LEADING_SLASHES = /^\/+/
const RE_TRAILING_SLASHES = /\/+$/

export interface ODataServiceState extends Omit<ODataServiceConfig, 'route' | 'strategy' | 'url'> {
  name: string
  url?: string
  route: string
  strategy: 'proxied' | 'direct'
  entities: EntityMapping[]
  config: {
    headers?: Record<string, string>
    auth?: any
  }
  headers?: Record<string, string>
  version?: string
  health?: 'online' | 'offline' | 'checking' | 'degraded'
  icon?: string
  metadata?: {
    status?: 'available' | 'stale' | 'missing'
    source?: 'remote' | 'cache' | 'local' | null
    stale?: boolean
    staleReason?: string | null
    message?: string
    refreshedAt?: string | null
  }
  isGenerated?: boolean
  generation?: {
    supported?: boolean
  }
  capabilities?: {
    sdkGeneration?: boolean
    generatedTypes?: boolean
  }
}

export interface ODataConfig {
  basePath: string
  mode?: string
  services: any[]
  apiBase?: string
  capabilities?: {
    sdkGeneration?: boolean
    generatedTypes?: boolean
  }
  forwardAuthHeader?: boolean
  versions?: {
    node: string
    module: string
  }
}

export type ProxyTraceEntry = CoreProxyTraceEntry

export interface ODataLog extends Omit<CoreODataLog, 'timestamp'> {
  timestamp: number | string
  path?: string
}

export type LogFilterStatus = 'all' | 'success' | 'failures'

export interface FilterRule {
  type: 'rule'
  field: string
  operator: string
  value: string | number
}

export interface FilterGroup {
  type: 'group'
  logic: 'and' | 'or'
  items: Array<FilterRule | FilterGroup>
}

export interface VisualQueryState {
  filters: FilterGroup
  select: string[]
  expand: string[]
  sortBy: { field: string, direction: 'asc' | 'desc' }[]
  top: number | null
  skip: number | null
}

export interface EditorState {
  show: boolean
  mode: 'view' | 'create' | 'update' | 'headers' | 'response'
  json: string
  loading: boolean
  error: string | null
  original: any
  context?: string
  headersServiceName?: string
  target?: ExplorerMutationTarget
  targetError?: string
}

function getDefaultQueryState(): VisualQueryState {
  return {
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
}

function serviceHasEntity(service: any, entity: string): boolean {
  return (service.entities || []).some((item: any) =>
    item.entitySet === entity || item.name === entity,
  )
}

function serviceMatchesLogFilter(service: any, filter: string): boolean {
  const normalizedFilter = filter.toLowerCase()
  return [service.name, service.route].some(value =>
    typeof value === 'string' && value.toLowerCase() === normalizedFilter,
  )
}

function encodeInternalQueryValue(value: string): string {
  return encodeURIComponent(value)
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string')
    return ''
  return value.trim().replace(RE_TRAILING_SLASHES, '')
}

function getConfiguredOdxApiBase(): string {
  try {
    const globalRuntimeConfig = (globalThis as any).useRuntimeConfig
    if (typeof globalRuntimeConfig === 'function') {
      const runtimeConfig = globalRuntimeConfig()
      return normalizeBaseUrl(runtimeConfig.public?.odxApiBase)
    }
    if (typeof useRuntimeConfig === 'function') {
      const runtimeConfig = useRuntimeConfig()
      return normalizeBaseUrl(runtimeConfig.public?.odxApiBase)
    }
  }
  catch {}
  return ''
}

export function buildOdxApiEndpoint(path: string): string {
  const normalizedPath = path.startsWith('/__odx__')
    ? path
    : `/__odx__/${path.replace(RE_LEADING_SLASHES, '')}`
  const apiBase = getConfiguredOdxApiBase()

  if (!apiBase)
    return normalizedPath

  if (apiBase.endsWith('/__odx__'))
    return `${apiBase}${normalizedPath.slice('/__odx__'.length)}`

  return `${apiBase}${normalizedPath}`
}

export function buildRuntimeProxyUrl(path: string): string {
  if (RE_ABSOLUTE_HTTP_URL.test(path))
    return path

  const apiBase = getConfiguredOdxApiBase()
  if (!apiBase)
    return path

  try {
    const base = new URL(apiBase, 'http://odx.local')
    const hostBase = base.pathname.endsWith('/__odx__')
      ? base.pathname.slice(0, -'/__odx__'.length)
      : base.pathname.replace(RE_TRAILING_SLASHES, '')
    const origin = apiBase.startsWith('//') ? `//${base.host}` : RE_ABSOLUTE_HTTP_URL.test(apiBase) ? base.origin : ''
    return `${origin}${hostBase}${path}`
  }
  catch {
    return path
  }
}

export function supportsSdkGeneration(config: ODataConfig, service?: Partial<ODataServiceState> | null): boolean {
  return service?.generation?.supported === true
    || service?.capabilities?.sdkGeneration === true
    || config.capabilities?.sdkGeneration === true
    || Boolean(config.versions?.node)
}

export function hasGeneratedTypes(config: ODataConfig): boolean {
  return config.capabilities?.generatedTypes === true || Boolean(config.versions?.node)
}

export function buildSchemaEndpointUrl(service: string, options: { raw?: boolean } = {}): string {
  const query = [`service=${encodeInternalQueryValue(service)}`]
  if (options.raw) {
    query.push('raw=true')
  }
  return buildOdxApiEndpoint(`/__odx__/schema?${query.join('&')}`)
}

function buildGenerateEndpointUrl(service: string): string {
  return buildOdxApiEndpoint(`/__odx__/generate?service=${encodeInternalQueryValue(service)}`)
}

export function buildEntityPreviewCacheKey(service: string, entity: string): string {
  return JSON.stringify([service, entity])
}

const DEGRADED_STORAGE_KEY = 'odx:degraded-services'
const LOG_SEARCH_SEPARATOR_RE = /\s+/

function loadDegradedServices(): Record<string, 'degraded'> {
  try {
    const raw = localStorage.getItem(DEGRADED_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  }
  catch { return {} }
}

function saveDegradedServices(overrides: Record<string, string>): void {
  const degraded = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v === 'degraded'),
  )
  try {
    if (Object.keys(degraded).length > 0)
      localStorage.setItem(DEGRADED_STORAGE_KEY, JSON.stringify(degraded))
    else
      localStorage.removeItem(DEGRADED_STORAGE_KEY)
  }
  catch {}
}

export interface SharedODataState {
  previewRequest: ReturnType<typeof createLatestRequest>
  configError: Ref<string | null>
  logsError: Ref<string | null>
  activeTab: Ref<string>
  logs: Ref<ODataLog[]>
  config: Ref<ODataConfig>
  services: ComputedRef<ODataServiceState[]>
  selectedService: Ref<ODataServiceState | null>
  selectedEntity: Ref<string | null>
  generatingStatus: Ref<Record<string, boolean>>
  sessionHeaders: Ref<Record<string, string>>
  getSessionHeaders: (serviceName: string) => Record<string, string>
  setSessionHeaders: (serviceName: string, headers: Record<string, string>) => void
  clearSessionHeaders: () => void
  logFilterService: Ref<string | null>
  logFilterStatus: Ref<LogFilterStatus>
  logSearch: Ref<string>
  filteredLogs: ComputedRef<ODataLog[]>
  hasActiveLogFilters: ComputedRef<boolean>
  hasFilteredOutLogs: ComputedRef<boolean>
  useCORSBridge: Ref<boolean>
  selectedTraceLogId: Ref<string | null>
  previewLoading: Ref<boolean>
  previewError: Ref<string | null>
  previewData: Ref<Record<string, any>[] | null>
  previewOwner: Ref<{ serviceName: string, entitySet: string } | null>
  queryInput: Ref<string>
  queryMethod: Ref<string>
  queryState: Ref<VisualQueryState>
  entitySchema: Ref<any>
  entitySchemaLoading: Ref<boolean>
  entityDataCache: Ref<Record<string, {
    data: any[]
    error: string | null
    query: string
    method: string
    queryState: VisualQueryState
  }>>
  globalViewMode: Ref<'explorer' | 'schema'>
  initializedServices: Ref<Set<string>>
  schemaFocusedServices: Ref<Set<string>>
  lastSelectedServiceForGraph: Ref<string | null>
  fetchConfig: () => Promise<void>
  refreshLogs: () => Promise<void>
  refreshServiceMetadata: (name: string) => Promise<any>
  clearLogFilters: () => void
  clearLogs: () => Promise<void>
  updateServiceHealth: (name: string, health: 'online' | 'offline' | 'checking' | 'degraded', force?: boolean) => void
}

function createSharedODataState(): SharedODataState {
  const previewRequest = createLatestRequest()
  const schemaRequest = createLatestRequest()
  const configRequest = createLatestRequest()
  const logsRequest = createLatestRequest()
  const clearLogsRequest = createLatestRequest()
  const configError = ref<string | null>(null)
  const logsError = ref<string | null>(null)
  let pendingLogs: Promise<void> | undefined
  let clearingLogs = false
  const activeTab = ref('overview')
  const logs = ref<ODataLog[]>([])
  const config = ref<ODataConfig>({ basePath: '/__odx__', mode: 'sdk', services: [] })
  const selectedService = ref<ODataServiceState | null>(null)
  const selectedEntity = ref<string | null>(null)
  const generatingStatus = ref<Record<string, boolean>>({})
  const headersByService = ref(new Map<string, Record<string, string>>())
  function getSessionHeaders(serviceName: string): Record<string, string> {
    return headersByService.value.get(serviceName) ?? {}
  }
  function setSessionHeaders(serviceName: string, headers: Record<string, string>): void {
    headersByService.value.set(serviceName, { ...headers })
  }
  function clearSessionHeaders(): void {
    headersByService.value.clear()
  }
  const sessionHeaders = computed({
    get: () => selectedService.value ? getSessionHeaders(selectedService.value.name) : {},
    set: (headers: Record<string, string>) => {
      if (selectedService.value)
        setSessionHeaders(selectedService.value.name, headers)
    },
  })
  const logFilterService = ref<string | null>(null)
  const logFilterStatus = ref<LogFilterStatus>('all')
  const logSearch = ref('')
  const useCORSBridge = ref(true)
  const selectedTraceLogId = ref<string | null>(null)
  const globalViewMode = ref<'explorer' | 'schema'>('explorer')

  // Entity Preview state
  const previewLoading = ref(false)
  const previewError = ref<string | null>(null)
  const previewData = ref<Record<string, any>[] | null>(null)
  const previewOwner = ref<{ serviceName: string, entitySet: string } | null>(null)
  const queryInput = ref('?')
  const queryMethod = ref('GET')
  const queryState = ref<VisualQueryState>(getDefaultQueryState())
  const entitySchema = ref<any>(null)
  const entitySchemaLoading = ref(false)

  // Cache for entity data to avoid reloading when switching entities
  const entityDataCache = ref<Record<string, {
    data: any[]
    error: string | null
    query: string
    method: string
    queryState: VisualQueryState
  }>>({})

  // Schema Explorer state
  const initializedServices = ref(new Set<string>())
  const schemaFocusedServices = ref(new Set<string>())
  const lastSelectedServiceForGraph = ref<string | null>(null)

  const serviceHealthOverrides = ref<Record<string, 'online' | 'offline' | 'checking' | 'degraded'>>(loadDegradedServices())

  onScopeDispose(() => {
    clearSessionHeaders()
    logs.value = []
    entityDataCache.value = {}
    previewData.value = null
    previewOwner.value = null
  })

  function updateServiceHealth(name: string, health: 'online' | 'offline' | 'checking' | 'degraded', force = false): void {
    // Background schema checks must not clear degraded state; only a forced
    // refresh can confirm that the latest metadata is usable again.
    if (health === 'online' && serviceHealthOverrides.value[name] === 'degraded' && !force)
      return
    serviceHealthOverrides.value[name] = health
    saveDegradedServices(serviceHealthOverrides.value)
    // Ensure selectedService ref is updated if it's the one being changed
    if (selectedService.value && selectedService.value.name === name) {
      selectedService.value = { ...selectedService.value, health }
    }
  }

  async function checkServiceHealth(name: string, request: ReturnType<typeof configRequest.begin>): Promise<void> {
    try {
      const res = await fetch(buildSchemaEndpointUrl(name), { signal: request.signal })
      if (!request.isCurrent())
        return
      if (!res.ok) {
        updateServiceHealth(name, 'offline')
        return
      }
      const body = await res.json().catch(() => null)
      if (!request.isCurrent())
        return
      updateServiceHealth(name, body?.metadata?.stale ? 'degraded' : 'online')
    }
    catch {
      if (request.isCurrent())
        updateServiceHealth(name, 'offline')
    }
  }

  async function fetchConfig(): Promise<void> {
    const request = configRequest.begin()
    try {
      const res = await fetch(buildOdxApiEndpoint('/__odx__/config'), { signal: request.signal })
      if (!request.isCurrent())
        return
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          config.value = { basePath: config.value.basePath, services: [] }
          clearSessionHeaders()
          entityDataCache.value = {}
        }
        throw new Error(`Explorer configuration unavailable (HTTP ${res.status}).`)
      }
      const body = await res.json()
      if (!request.isCurrent())
        return
      config.value = { ...body, apiBase: getConfiguredOdxApiBase() || 'same-origin' }
      configError.value = null
      config.value.services?.forEach((s: any) => {
        checkServiceHealth(s.name, request)
      })
    }
    catch (e) {
      if (request.isCurrent())
        configError.value = e instanceof Error ? e.message : 'Explorer configuration unavailable.'
    }
  }

  function refreshLogs(): Promise<void> {
    if (clearingLogs)
      return Promise.resolve()
    if (pendingLogs)
      return pendingLogs
    const pending = readLogs().finally(() => {
      if (pendingLogs === pending)
        pendingLogs = undefined
    })
    pendingLogs = pending
    return pending
  }

  async function readLogs(): Promise<void> {
    const request = logsRequest.begin()
    try {
      const res = await fetch(buildOdxApiEndpoint('/__odx__/logs'), { signal: request.signal })
      if (!request.isCurrent())
        return
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          logs.value = []
          selectedTraceLogId.value = null
        }
        throw new Error(`Traffic logs unavailable (HTTP ${res.status}).`)
      }
      const body = await res.json()
      if (!request.isCurrent())
        return
      logs.value = body
      logsError.value = null
      reconcileSelectedTraceLog()
    }
    catch (e) {
      if (request.isCurrent())
        logsError.value = e instanceof Error ? e.message : 'Traffic logs unavailable.'
    }
  }

  function reconcileSelectedTraceLog(): void {
    if (selectedTraceLogId.value && !logs.value.some(log => log.id === selectedTraceLogId.value)) {
      selectedTraceLogId.value = null
    }
  }

  function clearSelectedEntityState(): void {
    selectedEntity.value = null
    entitySchema.value = null
    previewData.value = null
    previewOwner.value = null
    previewError.value = null
    queryInput.value = '?'
    queryMethod.value = 'GET'
    queryState.value = getDefaultQueryState()
  }

  const services = computed(() => {
    const data = config.value.services || []
    return data.map((s: any) => {
      if (s.metadata?.status === 'missing') {
        return {
          ...s,
          health: 'offline',
        }
      }
      if (s.metadata?.status === 'stale') {
        return {
          ...s,
          health: 'degraded',
        }
      }

      return {
        ...s,
        health: serviceHealthOverrides.value[s.name] || s.health || 'checking',
      }
    })
  })

  const filteredLogs = computed(() => {
    const serviceFilter = logFilterService.value?.toLowerCase()
    const statusFilter = logFilterStatus.value
    const searchTokens = logSearch.value
      .trim()
      .toLowerCase()
      .split(LOG_SEARCH_SEPARATOR_RE)
      .filter(Boolean)

    return logs.value.filter((log: ODataLog) => {
      if (serviceFilter) {
        if (!log.service)
          return false
        const serviceName = log.service.toLowerCase()
        const matchesService = serviceName === serviceFilter
          || services.value.some(service => service.name.toLowerCase() === serviceName && service.route?.toLowerCase() === serviceFilter)
        if (!matchesService)
          return false
      }

      if (statusFilter !== 'all') {
        if (log.isPending || log.status === undefined || log.status === null)
          return false
        const status = Number(log.status)
        const failed = status >= 400
        if (statusFilter === 'failures' && !failed)
          return false
        if (statusFilter === 'success' && failed)
          return false
      }

      if (searchTokens.length > 0) {
        const searchable = [
          log.service,
          log.entitySet,
          log.path,
          log.url,
          log.targetUrl,
          log.method,
          log.status,
        ]
          .filter(value => value !== undefined && value !== null)
          .join(' ')
          .toLowerCase()

        if (!searchTokens.every(token => searchable.includes(token)))
          return false
      }

      return true
    })
  })

  const hasActiveLogFilters = computed(() => {
    return Boolean(logFilterService.value)
      || logFilterStatus.value !== 'all'
      || logSearch.value.trim().length > 0
  })

  const hasFilteredOutLogs = computed(() => {
    return hasActiveLogFilters.value
      && logs.value.length > 0
      && filteredLogs.value.length === 0
  })

  watch(config, (data) => {
    if (selectedService.value) {
      const currentService = selectedService.value
      const updated = services.value.find(s => s.name === currentService.name)
      if (updated) {
        selectedService.value = updated
        if (selectedEntity.value && !serviceHasEntity(updated, selectedEntity.value)) {
          clearSelectedEntityState()
        }
      }
      else {
        selectedService.value = null
        clearSelectedEntityState()
      }
    }

    if (logFilterService.value && !data.services.some((s: any) => serviceMatchesLogFilter(s, logFilterService.value!))) {
      logFilterService.value = null
    }
  }, { deep: true })

  async function refreshServiceMetadata(name: string): Promise<any> {
    generatingStatus.value[name] = true
    try {
      const res = await fetch(buildGenerateEndpointUrl(name))
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        const msg = body?.message || body?.statusMessage || `Metadata refresh failed (${res.status})`
        throw new Error(msg)
      }
      const body = await res.json().catch(() => null)
      await fetchConfig()
      if (body?.stale) {
        updateServiceHealth(name, 'degraded')
        const err = new Error(body.staleReason || 'Backend unreachable - using cached metadata') as any
        err.stale = true
        err.result = body
        throw err
      }
      else {
        updateServiceHealth(name, 'online', true)
      }
      return body
    }
    finally {
      generatingStatus.value[name] = false
    }
  }

  async function clearLogs(): Promise<void> {
    if (clearingLogs)
      return
    const request = clearLogsRequest.begin()
    clearingLogs = true
    logsRequest.cancel()
    pendingLogs = undefined
    try {
      const response = await fetch(buildOdxApiEndpoint('/__odx__/logs'), { method: 'DELETE', signal: request.signal })
      if (!request.isCurrent())
        return
      if (!response.ok)
        throw new Error(`Traffic logs could not be cleared (HTTP ${response.status}).`)
      logs.value = []
      logsError.value = null
      selectedTraceLogId.value = null
    }
    catch (e) {
      if (!request.isCurrent())
        return
      logsError.value = e instanceof Error ? e.message : 'Traffic logs could not be cleared.'
      throw e
    }
    finally {
      clearingLogs = false
    }
  }

  function clearLogFilters(): void {
    logFilterService.value = null
    logFilterStatus.value = 'all'
    logSearch.value = ''
  }

  // Watch for selectedEntity changes to update the entitySchema and restore cached data
  watch([() => selectedService.value?.name, selectedEntity], async ([svcName, newEntity]) => {
    previewRequest.cancel()
    previewLoading.value = false
    schemaRequest.cancel()
    entitySchema.value = null
    entitySchemaLoading.value = false
    if (!newEntity || !svcName) {
      entitySchema.value = null
      previewData.value = null
      previewOwner.value = null
      previewError.value = null
      return
    }

    const request = schemaRequest.begin()
    const cacheKey = buildEntityPreviewCacheKey(svcName, newEntity)
    const cached = entityDataCache.value[cacheKey]

    if (cached) {
      previewData.value = cached.data
      previewOwner.value = { serviceName: svcName, entitySet: newEntity }
      previewError.value = cached.error
      queryInput.value = cached.query
      queryMethod.value = cached.method
      queryState.value = JSON.parse(JSON.stringify(cached.queryState))
    }
    else {
      previewData.value = null
      previewOwner.value = null
      previewError.value = null
      queryMethod.value = 'GET'
      queryInput.value = '?'
      queryState.value = getDefaultQueryState()
    }

    entitySchemaLoading.value = true
    try {
      const res = await fetch(buildSchemaEndpointUrl(svcName), { signal: request.signal })
      if (!request.isCurrent())
        return
      if (res.ok) {
        const body = await res.json()
        if (!request.isCurrent())
          return
        entitySchema.value = body
        updateServiceHealth(svcName, body?.metadata?.stale ? 'degraded' : 'online')
      }
      else {
        updateServiceHealth(svcName, 'offline')
      }
    }
    catch (e) {
      if (!request.isCurrent())
        return
      console.error(`[ODataState] Failed to fetch schema for ${newEntity}`, e)
      updateServiceHealth(svcName, 'offline')
    }
    finally {
      if (request.isCurrent())
        entitySchemaLoading.value = false
    }
  }, { flush: 'sync' })

  return {
    previewRequest,
    configError,
    logsError,
    activeTab,
    logs,
    config,
    services,
    selectedService,
    selectedEntity,
    generatingStatus,
    sessionHeaders,
    getSessionHeaders,
    setSessionHeaders,
    clearSessionHeaders,
    logFilterService,
    logFilterStatus,
    logSearch,
    filteredLogs,
    hasActiveLogFilters,
    hasFilteredOutLogs,
    useCORSBridge,
    selectedTraceLogId,
    previewLoading,
    previewError,
    previewData,
    previewOwner,
    queryInput,
    queryMethod,
    queryState,
    entitySchema,
    entitySchemaLoading,
    entityDataCache,
    globalViewMode,
    initializedServices,
    schemaFocusedServices,
    lastSelectedServiceForGraph,
    fetchConfig,
    refreshLogs,
    refreshServiceMetadata,
    clearLogFilters,
    clearLogs,
    updateServiceHealth,
  }
}

const getAppState = createAppState(createSharedODataState)

export function useSharedODataState(): SharedODataState {
  return getAppState(useNuxtApp().vueApp)
}
