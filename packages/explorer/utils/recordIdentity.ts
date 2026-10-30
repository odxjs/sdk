import type { ODataTypedKey, ODataTypedKeyPart } from '@me-tools/odx-core'
import { createODataEntityPath, createODataTypedKey, formatODataKey } from '@me-tools/odx-core'

export interface ExplorerRecordIdentity {
  readonly entityPath: string
  readonly key: ODataTypedKey
  readonly version: 'v2' | 'v4'
}

export interface ExplorerMutationTarget {
  readonly serviceName: string
  readonly entitySet: string
  readonly url: string
  readonly method: 'POST' | 'PATCH' | 'MERGE'
  readonly headers: Readonly<Record<string, string>>
  readonly key?: ODataTypedKey
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
  return Object.freeze({ entityPath: createODataEntityPath(entitySet, key), key, version: schema.version })
}
