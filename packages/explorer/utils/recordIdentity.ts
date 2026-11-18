import type { ODataTypedKey, ODataTypedKeyPart } from '@odxjs/core'
import { createODataEntityPath, createODataTypedKey, formatODataKey } from '@odxjs/core'

const RE_ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7E\x80-\xFF]*"$/

export interface ExplorerRecordIdentity {
  readonly entityPath: string
  readonly key: ODataTypedKey
  readonly version: 'v2' | 'v4'
  readonly navigationProperties: readonly string[]
}

export interface ExplorerMutationTarget {
  readonly serviceName: string
  readonly entitySet: string
  readonly url: string
  readonly method: 'POST' | 'PATCH' | 'MERGE' | 'DELETE'
  readonly headers: Readonly<Record<string, string>>
  readonly key?: ODataTypedKey
  readonly etag?: string
  readonly originalJson?: string
  readonly navigationProperties?: readonly string[]
}

/** Only changed structural fields belong in a record update, never expansions. */
export function prepareExplorerUpdatePayload(target: ExplorerMutationTarget, payload: Record<string, unknown>): Record<string, unknown> {
  const original: unknown = target.originalJson ? JSON.parse(target.originalJson) : null
  if (!isRecord(original))
    throw new Error('The original record snapshot is unavailable. No request was sent.')
  const changed: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(payload)) {
    if (field === '__metadata' || field.startsWith('@') || field.startsWith('#'))
      continue
    const unchanged = Object.hasOwn(original, field) && JSON.stringify(value) === JSON.stringify(original[field])
    if (target.navigationProperties?.includes(field)) {
      if (!unchanged)
        throw new Error('Edit navigation records separately. No request was sent.')
      continue
    }
    if (!unchanged)
      changed[field] = value
  }
  return changed
}

/** A row editor shows structural values; the View action retains the full row. */
export function createExplorerEditableRecord(row: Record<string, unknown>, navigationProperties: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([field]) => field !== '__metadata'
    && !field.startsWith('@') && !field.startsWith('#') && !navigationProperties.includes(field)))
}

/** Prefer the row's concurrency token over any generic session override. */
export function captureExplorerRecordHeaders(row: unknown, sessionHeaders: Record<string, string>): { headers: Readonly<Record<string, string>>, etag?: string } {
  const metadata = isRecord(row) && isRecord(row.__metadata) ? row.__metadata : undefined
  const value = isRecord(row) ? row['@odata.etag'] ?? metadata?.etag : undefined
  const headers = { ...sessionHeaders }
  if (value === undefined || value === null)
    return { headers: Object.freeze(headers) }
  if (typeof value !== 'string' || !RE_ENTITY_TAG.test(value.trim()))
    throw new Error('The record ETag is invalid. Reload data before editing. No request was sent.')
  const etag = value.trim()
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'if-match')
      delete headers[name]
  }
  headers['If-Match'] = etag
  return { headers: Object.freeze(headers), etag }
}

/** A partial update can omit keys, but cannot change its captured identity. */
export function assertExplorerKeyUnchanged(key: ODataTypedKey, payload: Record<string, unknown>): void {
  const parts = key['@odata.key'].map((part) => {
    const value = Object.hasOwn(payload, part.field) ? payload[part.field] : part.value
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      throw new Error('Key changes are not supported. No request was sent.')
    return { ...part, value }
  })
  const candidate = createODataTypedKey(parts, key.version)
  if (formatODataKey(candidate) !== formatODataKey(key))
    throw new Error('Key changes are not supported. No request was sent.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Resolve an exact metadata-owned identity; never guess a property named ID. */
export function resolveExplorerRecordIdentity(schema: unknown, entitySet: string, row: unknown): ExplorerRecordIdentity {
  if (!isRecord(schema) || (schema.version !== 'v2' && schema.version !== 'v4'))
    throw new Error('Record mutations require metadata with a supported OData version. No request was sent.')
  if (!isRecord(row))
    throw new Error('Record mutations require the original record. No request was sent.')
  const entities = Array.isArray(schema.entities) ? schema.entities : []
  const matches = entities.filter((entity: unknown): entity is Record<string, unknown> => isRecord(entity)
    && (typeof entity.entitySet === 'string' ? entity.entitySet === entitySet : entity.name === entitySet))
  const entity = matches[0]
  if (matches.length !== 1 || !entity)
    throw new Error(`Cannot identify the exact metadata for ${entitySet}. No request was sent.`)
  const properties = Array.isArray(entity.properties) ? entity.properties : []
  const keys = properties.filter(property => isRecord(property) && property.isKey === true)
  if (keys.length === 0)
    throw new Error(`Metadata declares no supported key for ${entitySet}. No request was sent.`)
  const parts: ODataTypedKeyPart[] = keys.map((property: unknown) => {
    if (!isRecord(property) || typeof property.name !== 'string' || typeof property.type !== 'string')
      throw new Error('Record key metadata is incomplete. No request was sent.')
    const value = row[property.name]
    if (!Object.hasOwn(row, property.name) || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean'))
      throw new Error(`Record key ${property.name} is missing or invalid. No request was sent.`)
    // Decimal JSON numbers can lose fractional precision even within the safe
    // integer range. Only their integer subset is provably exact after parsing.
    if (property.type === 'Edm.Decimal' && typeof value === 'number' && !Number.isSafeInteger(value))
      throw new Error('An exact Decimal record key requires a string. No request was sent.')
    return { field: property.name, type: property.type, value }
  })
  const key = createODataTypedKey(parts, schema.version)
  const navigationProperties = Object.freeze((Array.isArray(entity.navigationProperties) ? entity.navigationProperties : [])
    .filter((property: unknown): property is Record<string, unknown> => isRecord(property) && typeof property.name === 'string')
    .map(property => String(property.name)))
  return Object.freeze({ entityPath: createODataEntityPath(entitySet, key), key, version: schema.version, navigationProperties })
}
