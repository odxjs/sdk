import type { ODataExplorerHostCapabilities, ODataServiceConfig } from '@me-tools/odx-core'
import type { H3Event } from 'h3'
import { isProductionExplorerRuntime } from './explorer-policy'

const DATA_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'MERGE', 'DELETE']

export function resolveExplorerHostCapabilities(event: H3Event): ODataExplorerHostCapabilities {
  const development = !isProductionExplorerRuntime()
  return {
    metadataRefresh: true,
    sdkGeneration: development && typeof event.context.odataGenerator === 'function',
    generatedTypes: development,
  }
}

/** Project only restrictions the existing guard can determine statically. */
export function projectExplorerDataMethods(service: ODataServiceConfig): string[] {
  // The direct bridge intentionally does not execute proxied-service rules.
  if (service.strategy === 'direct')
    return [...DATA_METHODS]
  let allowed = [...DATA_METHODS]
  for (const rule of service.rules ?? []) {
    if (rule.type !== 'allowOnlyMethods' && rule.type !== 'denyMethods')
      continue
    const value: unknown = rule.value
    if (!Array.isArray(value) || !value.every(method => typeof method === 'string'))
      return []
    allowed = allowed.filter(method => rule.type === 'allowOnlyMethods' ? value.includes(method) : !value.includes(method))
  }
  return allowed
}
