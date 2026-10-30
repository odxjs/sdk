import type { EntityMapping } from '@me-tools/odx-core'
import type { ExplorerMutationTarget } from '../utils/recordIdentity'
import type { EditorState } from './useODataState'
import { flattenOData, validateODataIdentifier } from '@me-tools/odx-core'
import { useNuxtApp } from 'nuxt/app'
import { onScopeDispose, toRaw } from 'vue'
import { createAppState } from '../utils/appState'
import { captureExplorerRecordHeaders, createExplorerEditableRecord, resolveExplorerRecordIdentity } from '../utils/recordIdentity'
import { readExplorerRequestError } from '../utils/requestError'
import { buildEntityPreviewCacheKey, buildRuntimeProxyUrl } from './useODataState'

const RE_TRAILING_SLASH = /\/$/
const RE_ODATA_NUMERIC_TYPE = /(?:^|\.)(?:Byte|SByte|Int16|Int32|Int64|Decimal|Double|Single)$/
const RE_NUMERIC_LITERAL = /^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i
const RE_SINGLE_QUOTE = /'/g
const RE_QUERY_SEPARATOR_CHARS = /[&#]/g

export interface EntityExplorer {
  selectedService: Ref<any>
  selectedEntity: Ref<string | null>
  previewLoading: Ref<boolean>
  showLoadingIndicator: Ref<boolean>
  previewError: Ref<string | null>
  previewData: Ref<Record<string, any>[] | null>
  queryInput: Ref<string>
  queryMethod: Ref<string>
  queryState: Ref<VisualQueryState>
  entitySchema: Ref<any>
  entitySchemaLoading: Ref<boolean>
  editor: Ref<EditorState>
  currentEntitySchema: ComputedRef<any>
  previewColumns: ComputedRef<string[]>
  navigationItems: ComputedRef<any[]>
  refreshEntityData: () => Promise<void>
  reloadEntityData: () => Promise<void>
  resetQuery: () => void
  isNavigationProperty: (key: string) => boolean
  openEditor: (mode: 'view' | 'create' | 'update' | 'headers', row?: any) => void
  deleteItem: (row: Record<string, unknown>) => Promise<void>
  downloadJson: () => void
}

function createEntityExplorer(): EntityExplorer {
  const editor = ref<EditorState>({
    show: false,
    mode: 'view',
    json: '',
    loading: false,
    error: null,
    original: null,
  })

  const showLoadingIndicator = ref(false)

  const toast = useToast()
  const {
    selectedService,
    selectedEntity,
    config,
    getSessionHeaders,
    previewLoading,
    previewError,
    previewData,
    previewOwner,
    queryInput,
    queryMethod,
    queryState,
    useCORSBridge,
    entitySchema,
    entitySchemaLoading,
    entityDataCache,
    previewRequest,
    updateServiceHealth,
  } = useSharedODataState()

  let loadingTimeout: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  onScopeDispose(() => {
    disposed = true
    if (loadingTimeout)
      clearTimeout(loadingTimeout)
    editor.value = { show: false, mode: 'view', json: '', loading: false, error: null, original: null }
  })

  function getCurrentEntitySchema(): any {
    const entityName = selectedEntity.value
    if (!entitySchema.value || !entityName) {
      return null
    }

    const entities = entitySchema.value.entities || []
    return entities.find((e: any) =>
      e.name === entityName || e.entitySet === entityName,
    ) || entities.find((e: any) =>
      e.name.toLowerCase() === entityName.toLowerCase(),
    ) || entities.find((e: any) =>
      entityName.toLowerCase().startsWith(e.name.toLowerCase())
      || e.name.toLowerCase().startsWith(entityName.toLowerCase()),
    ) || null
  }

  function isNumericProperty(field: string): boolean {
    const propertyType = getCurrentEntitySchema()
      ?.properties
      ?.find((p: any) => p.name === field)
      ?.type
    return typeof propertyType === 'string' && RE_ODATA_NUMERIC_TYPE.test(propertyType)
  }

  function serializeStringLiteral(value: string): string {
    const escaped = value
      .replace(RE_SINGLE_QUOTE, '\'\'')
      .replace(RE_QUERY_SEPARATOR_CHARS, char => encodeURIComponent(char))
    return `'${escaped}'`
  }

  function serializeFilterValue(rule: any, forceStringLiteral = false): string {
    const value = rule.value
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!forceStringLiteral && isNumericProperty(rule.field) && RE_NUMERIC_LITERAL.test(trimmed)) {
        return trimmed
      }
      return serializeStringLiteral(value)
    }
    return String(value)
  }

  // Watch queryState and generate queryInput string
  watch(queryState, (newState) => {
    let q = '?'
    const parts: string[] = []

    // 1. $select
    if (newState.select && newState.select.length > 0) {
      parts.push(`$select=${newState.select.join(',')}`)
    }

    // 2. $expand
    if (newState.expand && newState.expand.length > 0) {
      parts.push(`$expand=${newState.expand.join(',')}`)
    }

    // 3. $filter (Recursive)
    function serializeRule(rule: any): string {
      const isFunctionFilter = rule.operator === 'contains' || rule.operator === 'startswith' || rule.operator === 'endswith'
      const val = serializeFilterValue(rule, isFunctionFilter)
      if (isFunctionFilter) {
        return `${rule.operator}(${rule.field},${val})`
      }
      return `${rule.field} ${rule.operator} ${val}`
    }

    function serializeGroup(group: any): string {
      if (!group.items || group.items.length === 0)
        return ''

      const filterParts = group.items.map((item: any) => {
        if (item.type === 'group') {
          const subGroup = serializeGroup(item)
          return subGroup ? `(${subGroup})` : ''
        }
        return serializeRule(item)
      }).filter(Boolean)

      if (filterParts.length === 0)
        return ''
      return filterParts.join(` ${group.logic} `)
    }

    const filterString = serializeGroup(newState.filters)
    if (filterString) {
      parts.push(`$filter=${filterString}`)
    }

    // 4. $orderby
    if (newState.sortBy && newState.sortBy.length > 0) {
      const orderParts = newState.sortBy
        .filter(s => s.field)
        .map(s => `${s.field} ${s.direction}`)
      parts.push(`$orderby=${orderParts.join(',')}`)
    }

    // 5. $top / $skip
    if (newState.top !== null && newState.top !== undefined) {
      parts.push(`$top=${newState.top}`)
    }
    if (newState.skip !== null && newState.skip !== undefined) {
      parts.push(`$skip=${newState.skip}`)
    }

    q += parts.join('&')
    if (q === '?')
      q = '?'

    queryInput.value = q
  }, { deep: true })

  function resetQuery(): void {
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
    queryInput.value = '?'
  }

  // Loading indicator local logic: debounce showing the overlay to prevent flickering on fast requests
  watch([previewLoading, entitySchemaLoading], ([pLoading, eLoading]) => {
    const isLoading = pLoading || eLoading

    if (loadingTimeout) {
      clearTimeout(loadingTimeout)
    }

    if (isLoading) {
      loadingTimeout = setTimeout(() => {
        showLoadingIndicator.value = true
      }, 400)
    }
    else {
      showLoadingIndicator.value = false
    }
  })

  function refreshEntityData(): Promise<void> {
    return executeEntityData(queryMethod.value)
  }

  function reloadEntityData(): Promise<void> {
    return executeEntityData('GET')
  }

  async function executeEntityData(method: string): Promise<void> {
    if (!selectedService.value || !selectedEntity.value) {
      return
    }

    const service = selectedService.value
    const entity = selectedEntity.value
    const svcName = service.name
    const query = queryInput.value
    // Navigation can supersede reads; aborting a dispatched write cannot undo it.
    const request = method === 'GET' ? previewRequest.begin() : null
    const isCurrent = (): boolean => request ? request.isCurrent() : !disposed
    const submittedQueryState = JSON.parse(JSON.stringify(queryState.value))
    const cacheKey = buildEntityPreviewCacheKey(svcName, entity)

    if (request) {
      previewLoading.value = true
      previewError.value = null
    }
    try {
      const isDirect = service.strategy === 'direct'
      let urlPath = ''

      if (isDirect && !useCORSBridge.value) {
        // True Direct Mode: Browser -> OData Service (Only if user explicitly opted-out of bridge)
        const baseUrl = service.url?.replace(RE_TRAILING_SLASH, '')
        urlPath = `${baseUrl}/${entity}`
      }
      else {
        // Proxied Mode: Browser -> Nitro -> OData Service
        // This is the default even for 'direct' services to avoid CORS issues in dev.
        const route = service.route || svcName.toLowerCase()
        urlPath = buildRuntimeProxyUrl(`${config.value.basePath}/${route}/${entity}`)
      }

      if (query && query !== '?') {
        const q = query.startsWith('?') ? query : `?${query}`
        urlPath += q
      }

      const res = await fetch(urlPath, {
        method,
        ...(request ? { signal: request.signal } : {}),
        headers: {
          'Accept': entitySchema.value?.name === service.name && entitySchema.value.version === 'v4'
            ? 'application/json;IEEE754Compatible=true'
            : 'application/json',
          'Content-Type': 'application/json',
          ...getSessionHeaders(service.name),
        },
      })
      if (!isCurrent())
        return
      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        let statusMessage = res.statusText || `Server Error ${res.status}`
        // If the body is parseable JSON the upstream service responded — only an empty
        // or non-JSON body on a 5xx means the proxy itself couldn't reach the service.
        let upstreamResponded = false
        try {
          const errData = JSON.parse(errorText)
          upstreamResponded = true
          // SAP OData: { error: { code, message } } — may be top-level or wrapped in
          // h3's { data: { error: { ... } } } when coming through proxy buffer mode.
          const sapError = errData.error ?? errData.data?.error
          if (sapError?.message) {
            statusMessage = sapError.message
          }
          else {
            statusMessage = errData.message || errData.statusMessage || errData.data?.statusMessage || statusMessage
          }
        }
        catch {
          if (errorText && errorText.length < 200) {
            statusMessage = errorText || statusMessage
          }
        }

        if (!isCurrent())
          return
        if (res.status >= 500 && !upstreamResponded) {
          updateServiceHealth(svcName, 'offline')
        }

        throw new Error(statusMessage)
      }

      const responseText = await res.text()
      if (!isCurrent())
        return
      updateServiceHealth(svcName, 'online')
      let data: any
      try {
        data = JSON.parse(responseText)
      }
      catch {
        data = { response: responseText }
      }

      // For non-GET requests (POST, PUT, PATCH, DELETE), we show the response in the editor
      if (method !== 'GET') {
        editor.value = {
          show: true,
          mode: 'response',
          json: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
          loading: false,
          error: null,
          original: null,
          context: `${method} ${svcName}/${entity}`,
        }
        return
      }

      const finalData = flattenOData(data)
      const dataArray = Array.isArray(finalData) ? finalData : (finalData ? [finalData] : [])
      previewOwner.value = { serviceName: svcName, entitySet: entity }
      previewData.value = dataArray

      // Update cache
      entityDataCache.value[cacheKey] = {
        data: [...dataArray],
        error: null,
        query,
        method,
        queryState: submittedQueryState,
      }
    }
    catch (e: unknown) {
      if (!isCurrent())
        return
      const msg = (e as Error).message
      if (!request) {
        editor.value = {
          show: true,
          mode: 'response',
          json: '{}',
          loading: false,
          error: msg,
          original: null,
          context: `${method} ${svcName}/${entity}`,
        }
        return
      }
      previewError.value = msg
      previewData.value = []
      previewOwner.value = null

      // Cache the error state too
      entityDataCache.value[cacheKey] = {
        data: [],
        error: msg,
        query,
        method,
        queryState: submittedQueryState,
      }
    }
    finally {
      if (request?.isCurrent())
        previewLoading.value = false
    }
  }

  const currentEntitySchema = computed(() => {
    return getCurrentEntitySchema()
  })

  const previewColumns = computed(() => {
    const edmxEntity = currentEntitySchema.value

    if (!edmxEntity) {
      if (previewData.value && previewData.value.length > 0) {
        return Object.keys(previewData.value[0] || {}).filter(k => k !== '__metadata')
      }
      return []
    }

    const edmxProps = edmxEntity.properties?.map((p: any) => p.name) || []
    const edmxNavProps = edmxEntity.navigationProperties?.map((np: any) => np.name) || []

    const combined = [...new Set([...edmxProps, ...edmxNavProps])]

    return combined.filter((col) => {
      const isTechnicalFK = (entitySchema.value?.associations || []).some((assoc: any) => {
        return assoc.constraint?.dependentProperty === col
      })
      return !isTechnicalFK
    })
  })

  function isNavigationProperty(key: string): boolean {
    return (currentEntitySchema.value?.navigationProperties || []).some((np: any) =>
      np.name.toLowerCase() === key.toLowerCase(),
    )
  }

  function captureMutationTarget(mode: 'create' | 'update', row: unknown): ExplorerMutationTarget {
    const service = selectedService.value
    const entitySet = selectedEntity.value
    if (!service || !entitySet)
      throw new Error('The original service and entity are unavailable. No request was sent.')
    validateODataIdentifier(entitySet, 'Explorer entity set')
    if (mode === 'update' && (previewOwner.value?.serviceName !== service.name
      || previewOwner.value.entitySet !== entitySet || !previewData.value?.some(record => toRaw(record) === toRaw(row)))) {
      throw new Error('This record does not belong to the displayed service and entity. Reload data before editing. No request was sent.')
    }
    if (mode === 'update' && entitySchema.value?.name !== service.name)
      throw new Error('Metadata for the original service is unavailable. No request was sent.')
    const identity = mode === 'update' ? resolveExplorerRecordIdentity(entitySchema.value, entitySet, row) : undefined
    const concurrency = captureExplorerRecordHeaders(mode === 'update' ? row : null, getSessionHeaders(service.name))
    const jsonType = identity?.version === 'v4' || (entitySchema.value?.name === service.name && entitySchema.value.version === 'v4')
      ? 'application/json;IEEE754Compatible=true'
      : 'application/json'
    const headers = { ...concurrency.headers }
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'accept' || name.toLowerCase() === 'content-type')
        delete headers[name]
    }
    headers.Accept = jsonType
    headers['Content-Type'] = jsonType
    const route = service.route || service.name.toLowerCase()
    return Object.freeze({
      serviceName: service.name,
      entitySet,
      url: buildRuntimeProxyUrl(`${config.value.basePath}/${route}/${identity?.entityPath ?? entitySet}`),
      method: mode === 'create' ? 'POST' : identity?.version === 'v2' ? 'MERGE' : 'PATCH',
      ...concurrency,
      headers: Object.freeze(headers),
      ...(identity ? { key: identity.key } : {}),
      ...(identity ? { originalJson: JSON.stringify(row), navigationProperties: identity.navigationProperties } : {}),
    })
  }

  function openEditor(mode: 'view' | 'create' | 'update' | 'headers', row: any = null): void {
    let initialJson = ''
    if (mode === 'headers') {
      // Configured outbound headers stay server-owned; only edit this service's
      // explicit browser-session overrides.
      initialJson = JSON.stringify(selectedService.value ? getSessionHeaders(selectedService.value.name) : {}, null, 2)
    }
    else if (row) {
      initialJson = JSON.stringify(row, null, 2)
    }
    else if (mode === 'create' && currentEntitySchema.value) {
      const template: Record<string, any> = {}
      currentEntitySchema.value.properties?.forEach((p: any) => {
        if (p.type.includes('Int') || p.type.includes('Decimal') || p.type.includes('Double')) {
          template[p.name] = 0
        }
        else if (p.type.includes('Boolean')) {
          template[p.name] = false
        }
        else {
          template[p.name] = ''
        }
      })
      initialJson = JSON.stringify(template, null, 2)
    }
    else {
      initialJson = JSON.stringify({ ID: '', Name: '' }, null, 2)
    }

    let target: ExplorerMutationTarget | undefined
    let targetError: string | undefined
    if (mode === 'create' || mode === 'update') {
      try {
        target = captureMutationTarget(mode, row)
        if (mode === 'update')
          initialJson = JSON.stringify(createExplorerEditableRecord(row, target.navigationProperties ?? []), null, 2)
      }
      catch (error) {
        targetError = error instanceof Error ? error.message : 'The record identity is unavailable. No request was sent.'
      }
    }
    editor.value = {
      show: true,
      mode,
      error: null,
      loading: false,
      original: row,
      json: initialJson,
      context: selectedEntity.value ?? undefined,
      headersServiceName: mode === 'headers' ? selectedService.value?.name : undefined,
      target,
      targetError,
    }
  }

  async function deleteItem(row: Record<string, unknown>): Promise<void> {
    try {
      const target = captureMutationTarget('update', row)
      // eslint-disable-next-line no-alert
      if (!confirm(`Delete this record from ${target.entitySet}?`))
        return
      const res = await fetch(target.url, {
        method: 'DELETE',
        headers: target.headers,
      })
      if (!res.ok)
        throw await readExplorerRequestError(res)
      if (res.ok) {
        delete entityDataCache.value[buildEntityPreviewCacheKey(target.serviceName, target.entitySet)]
        toast.add({
          title: `Record deleted from ${target.entitySet}`,
          icon: 'i-lucide-circle-check',
          color: 'success',
        })
        if (selectedService.value?.name === target.serviceName && selectedEntity.value === target.entitySet)
          await reloadEntityData()
      }
    }
    catch (e: unknown) {
      toast.add({
        title: (e as Error).message,
        icon: 'i-lucide-circle-x',
        color: 'error',
      })
    }
  }

  function downloadJson(): void {
    if (!previewData.value || previewData.value.length === 0) {
      return
    }
    const blob = new Blob([JSON.stringify(previewData.value, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedEntity.value}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const navigationItems = computed(() => {
    if (!selectedService.value?.entities)
      return []

    return [
      selectedService.value.entities.map((entity: EntityMapping) => ({
        label: entity.name,
        value: entity.name,
        active: selectedEntity.value === entity.name,
        onSelect: () => {
          selectedEntity.value = entity.name
        },
      })),
    ]
  })

  return {
    selectedService,
    selectedEntity,
    previewLoading,
    showLoadingIndicator,
    previewError,
    previewData,
    queryInput,
    queryMethod,
    entitySchema,
    entitySchemaLoading,
    editor,
    currentEntitySchema,
    previewColumns,
    navigationItems,
    refreshEntityData,
    reloadEntityData,
    resetQuery,
    isNavigationProperty,
    openEditor,
    deleteItem,
    downloadJson,
    queryState,
  }
}

const getAppEntityExplorer = createAppState(createEntityExplorer)

export function useEntityExplorer(): EntityExplorer {
  return getAppEntityExplorer(useNuxtApp().vueApp)
}
