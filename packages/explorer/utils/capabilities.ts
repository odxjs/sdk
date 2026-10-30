interface MethodProjection {
  capabilities?: { dataMethods?: unknown }
}

/** Advisory host projection; every dispatched request still needs server checks. */
export function permitsExplorerDataMethod(service: MethodProjection | null | undefined, method: string): boolean {
  if (!service)
    return false
  const methods = service.capabilities?.dataMethods
  // Independently hosted Explorer layers may not project static rules yet.
  if (methods === undefined)
    return true
  return Array.isArray(methods) && methods.every(value => typeof value === 'string') && methods.includes(method)
}
