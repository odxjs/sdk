import type { EntityMapping } from '@me-tools/odx-core'
import type { ExplorerMutationTarget } from '../utils/recordIdentity'
import type { EditorState, ODataServiceState } from './useODataState'
import { flattenOData, validateODataIdentifier } from '@me-tools/odx-core'
import { useNuxtApp } from 'nuxt/app'
import { onScopeDispose, toRaw } from 'vue'
import { createAppState } from '../utils/appState'
import { permitsExplorerDataMethod } from '../utils/capabilities'
import { captureExplorerRecordHeaders, createExplorerEditableRecord, resolveExplorerRecordIdentity } from '../utils/recordIdentity'
import { readExplorerRequestError } from '../utils/requestError'
import { createExplorerJSONHeaders, isExplorerWriteMethod } from '../utils/requestTarget'
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
    if (queryMethod.value === 'GET')
      return reloadEntityData()
    const service = selectedService.value
    const entity = selectedEntity.value
    if (!service || !entity)
      return Promise.resolve()
    if (!isExplorerWriteMethod(queryMethod.value)) {
      previewError.value = 'Unsupported request method. No request was sent.'
      return Promise.resolve()
    }
    if (!permitsExplorerDataMethod(config.value.services.find(candidate => candidate.name === service.name), queryMethod.value)) {
      previewError.value = `${queryMethod.value} is disabled by the host service policy. No request was sent.`
      return Promise.resolve()
    }
    try {
      const target = Object.freeze({
        serviceName: service.name,
        entitySet: entity,
        url: buildEntityRequestUrl(service, entity, queryInput.value, true),
        method: queryMethod.value,
        headers: createExplorerJSONHeaders(getSessionHeaders(service.name), entitySchema.value?.name === service.name ? entitySchema.value.version : undefined),
      })
      editor.value = {
        show: true,
        mode: 'request',
        json: '{}',
        loading: false,
        error: null,
        original: null,
        context: `${target.method} ${target.url}`,
        requestTarget: target,
      }
    }
    catch (error) {
      previewError.value = error instanceof Error ? error.message : String(error)
    }
    return Promise.resolve()
  }

  function reloadEntityData(): Promise<void> {
    return executeEntityData()
  }

  function buildEntityRequestUrl(service: ODataServiceState, entity: string, query: string, throughProxy = false): string {
    validateODataIdentifier(entity, 'Explorer entity set')
    let path: string
    if (!throughProxy && service.strategy === 'direct' && !useCORSBridge.value) {
      if (!service.url)
        throw new Error('The configured direct service URL is unavailable. No request was sent.')
      path = `${service.url.replace(RE_TRAILING_SLASH, '')}/${entity}`
    }
    else {
      const route = service.route || service.name.toLowerCase()
      path = buildRuntimeProxyUrl(`${config.value.basePath}/${route}/${entity}`)
    }
    return query && query !== '?' ? `${path}${query.startsWith('?') ? query : `?${query}`}` : path
  }

  async function executeEntityData(): Promise<void> {
    if (!selectedService.value || !selectedEntity.value) {
      return
    }

    const service = selectedService.value
    const entity = selectedEntity.value
    const svcName = service.name
    const query = queryInput.value
    const method = 'GET'
    const request = previewRequest.begin()
    const isCurrent = (): boolean => !disposed && request.isCurrent()
    const submittedQueryState = JSON.parse(JSON.stringify(queryState.value))
    const cacheKey = buildEntityPreviewCacheKey(svcName, entity)
    if (!permitsExplorerDataMethod(config.value.services.find(candidate => candidate.name === service.name), method)) {
      previewRequest.cancel()
      previewLoading.value = false
      previewError.value = 'GET is disabled by the host service policy. No request was sent.'
      previewData.value = null
      previewOwner.value = null
      delete entityDataCache.value[cacheKey]
      return
    }

    previewLoading.value = true
    previewError.value = null
    try {
      const res = await fetch(buildEntityRequestUrl(service, entity, query), {
        method,
        signal: request.signal,
        headers: createExplorerJSONHeaders(getSessionHeaders(service.name), entitySchema.value?.name === service.name ? entitySchema.value.version : undefined),
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
      if (isCurrent())
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

  function captureMutationTarget(mode: 'create' | 'update' | 'delete', row: unknown): ExplorerMutationTarget {
    const service = selectedService.value
    const entitySet = selectedEntity.value
    if (!service || !entitySet)
      throw new Error('The original service and entity are unavailable. No request was sent.')
    validateODataIdentifier(entitySet, 'Explorer entity set')
    if (mode !== 'create' && (previewOwner.value?.serviceName !== service.name
      || previewOwner.value.entitySet !== entitySet || !previewData.value?.some(record => toRaw(record) === toRaw(row)))) {
      throw new Error('This record does not belong to the displayed service and entity. Reload data before editing. No request was sent.')
    }
    if (mode !== 'create' && entitySchema.value?.name !== service.name)
      throw new Error('Metadata for the original service is unavailable. No request was sent.')
    const identity = mode !== 'create' ? resolveExplorerRecordIdentity(entitySchema.value, entitySet, row) : undefined
    const method = mode === 'create' ? 'POST' : mode === 'delete' ? 'DELETE' : identity?.version === 'v2' ? 'MERGE' : 'PATCH'
    if (!permitsExplorerDataMethod(config.value.services.find(candidate => candidate.name === service.name), method))
      throw new Error(`${method} is disabled by the host service policy. No request was sent.`)
    const concurrency = captureExplorerRecordHeaders(mode !== 'create' ? row : null, getSessionHeaders(service.name))
    const headers = createExplorerJSONHeaders(concurrency.headers, identity?.version ?? (entitySchema.value?.name === service.name ? entitySchema.value.version : undefined))
    const route = service.route || service.name.toLowerCase()
    return Object.freeze({
      serviceName: service.name,
      entitySet,
      url: buildRuntimeProxyUrl(`${config.value.basePath}/${route}/${identity?.entityPath ?? entitySet}`),
      method,
      ...concurrency,
      headers,
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
      const target = captureMutationTarget('delete', row)
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
