export const EXPLORER_WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'MERGE', 'DELETE'] as const
export type ExplorerWriteMethod = typeof EXPLORER_WRITE_METHODS[number]
const WRITE_METHODS: ReadonlySet<string> = new Set(EXPLORER_WRITE_METHODS)

export interface ExplorerRequestTarget {
  readonly serviceName: string
  readonly entitySet: string
  readonly url: string
  readonly method: ExplorerWriteMethod
  readonly headers: Readonly<Record<string, string>>
}

export function isExplorerWriteMethod(value: string): value is ExplorerWriteMethod {
  return WRITE_METHODS.has(value)
}

/** Structured JSON requests retain their negotiated representation. */
export function createExplorerJSONHeaders(sessionHeaders: Readonly<Record<string, string>>, version: unknown): Readonly<Record<string, string>> {
  const headers = Object.fromEntries(Object.entries(sessionHeaders).filter(([name]) => name.toLowerCase() !== 'accept' && name.toLowerCase() !== 'content-type'))
  const jsonType = version === 'v4' ? 'application/json;IEEE754Compatible=true' : 'application/json'
  return Object.freeze({ ...headers, 'Accept': jsonType, 'Content-Type': jsonType })
}
