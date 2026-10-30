import { describe, expect, it } from 'vitest'
import { assertExplorerKeyUnchanged, captureExplorerRecordHeaders, createExplorerEditableRecord, prepareExplorerUpdatePayload, resolveExplorerRecordIdentity } from '../utils/recordIdentity'

function schema(version: 'v2' | 'v4', keys: [string, string][]) {
  return { version, entities: [{ name: 'Records', properties: keys.map(([name, type]) => ({ name, type, isKey: true })) }] }
}

describe('metadata-owned Explorer record identity', () => {
  it('sends only changed structural fields and rejects deep updates to expanded navigation', () => {
    const original = { 'ID': 0, 'Name': 'Old name', 'Price': 10, 'Supplier': { ID: 'S1', Name: 'Expanded supplier' }, '@odata.etag': 'W/"1"' }
    const target = { serviceName: 'Catalog', entitySet: 'Products', url: '/api/Products(0)', method: 'PATCH' as const, headers: {}, originalJson: JSON.stringify(original), navigationProperties: Object.freeze(['Supplier']) }
    expect(createExplorerEditableRecord(original, ['Supplier'])).toEqual({ ID: 0, Name: 'Old name', Price: 10 })
    expect(prepareExplorerUpdatePayload(target, { ...original, 'Name': 'Changed name', '@odata.etag': '*' })).toEqual({ Name: 'Changed name' })
    expect(prepareExplorerUpdatePayload(target, { ID: 0, Name: 'Old name' })).toEqual({})
    expect(() => prepareExplorerUpdatePayload(target, { Supplier: { ID: 'S1', Name: 'Overwrite related record' } })).toThrow('Edit navigation records separately')
    original.Price = 99
    expect(prepareExplorerUpdatePayload(target, { Price: 10 })).toEqual({})
  })

  it.each([{ '@odata.etag': 'W/"1"' }, { __metadata: { etag: 'W/"1"' } }])('freezes the original row ETag and replaces case-insensitive wildcard overrides', (row) => {
    const session = { 'if-match': '*', 'IF-MATCH': '*', 'X-Session': 'synthetic' }
    const target = captureExplorerRecordHeaders(row, session)
    session['X-Session'] = 'changed'
    expect(target).toEqual({ headers: { 'If-Match': 'W/"1"', 'X-Session': 'synthetic' }, etag: 'W/"1"' })
    expect(Object.isFrozen(target.headers)).toBe(true)
  })

  it('leaves services without ETags usable and rejects malformed row tokens', () => {
    expect(captureExplorerRecordHeaders({}, {})).toEqual({ headers: {} })
    for (const etag of ['*', 'unquoted', 'W/"one"\r\nX-Test: bad', 42])
      expect(() => captureExplorerRecordHeaders({ '@odata.etag': etag }, {})).toThrow('record ETag is invalid')
  })

  it.each(['Edm.Int64', 'Edm.Decimal'])('rejects an already rounded numeric %s key and preserves its exact string form', (type) => {
    const metadata = schema('v4', [['Number', type]])
    const rounded: unknown = JSON.parse('{"Number":9007199254740993}')
    expect(() => resolveExplorerRecordIdentity(metadata, 'Records', rounded)).toThrow(/requires a string/)
    expect(resolveExplorerRecordIdentity(metadata, 'Records', { Number: '9007199254740993' }).entityPath)
      .toBe('Records(9007199254740993)')
  })

  it('rejects fractional Decimal JSON numbers whose original precision is unknown', () => {
    const metadata = schema('v4', [['Amount', 'Edm.Decimal']])
    expect(() => resolveExplorerRecordIdentity(metadata, 'Records', JSON.parse('{"Amount":1.234567890123456789}'))).toThrow('requires a string')
    expect(resolveExplorerRecordIdentity(metadata, 'Records', { Amount: '1.234567890123456789' }).entityPath)
      .toBe('Records(1.234567890123456789)')
  })

  it('uses a differently named zero key and freezes the dispatched identity', () => {
    const record = { ProductNumber: 0, ID: 'not-the-key' }
    const identity = resolveExplorerRecordIdentity(schema('v4', [['ProductNumber', 'Edm.Int32']]), 'Records', record)
    record.ProductNumber = 9
    expect(identity.entityPath).toBe('Records(0)')
    expect(identity.key['@odata.key'][0]?.value).toBe(0)
    expect(Object.isFrozen(identity.key['@odata.key'][0])).toBe(true)
  })

  it('preserves string keys and escapes path/query delimiters through core', () => {
    const identity = resolveExplorerRecordIdentity(schema('v4', [['Code', 'Edm.String']]), 'Records', { Code: 'O\'Brien/?&' })
    expect(identity.entityPath).toBe('Records(\'O\'\'Brien%2F%3F%26\')')
  })

  it.each([
    ['v4', 'Records(Tenant=\'north%2Fsouth\',Number=7)'],
    ['v2', 'Records(Tenant=\'north%2Fsouth\',Number=7L)'],
  ] as const)('retains composite key names, order and %s literals', (version, path) => {
    const identity = resolveExplorerRecordIdentity(schema(version, [['Tenant', 'Edm.String'], ['Number', 'Edm.Int64']]), 'Records', { Number: '7', Tenant: 'north/south' })
    expect(identity.entityPath).toBe(path)
  })

  it.each([
    ['v4', 'Records(01234567-89ab-cdef-0123-456789abcdef)'],
    ['v2', 'Records(guid\'01234567-89ab-cdef-0123-456789abcdef\')'],
  ] as const)('uses protocol-owned %s GUID syntax', (version, path) => {
    expect(resolveExplorerRecordIdentity(schema(version, [['Key', 'Edm.Guid']]), 'Records', { Key: '01234567-89ab-cdef-0123-456789abcdef' }).entityPath).toBe(path)
  })

  it('rejects missing or inherited values instead of falling back to ID', () => {
    const metadata = schema('v4', [['Code', 'Edm.String']])
    expect(() => resolveExplorerRecordIdentity(metadata, 'Records', { ID: 1 })).toThrow('Record key Code is missing')
    expect(() => resolveExplorerRecordIdentity(metadata, 'Records', Object.create({ Code: 'inherited' }))).toThrow('Record key Code is missing')
    expect(() => resolveExplorerRecordIdentity(metadata, 'Records', { Code: null })).toThrow('Record key Code is missing')
  })

  it('fails closed for unavailable, ambiguous or different entity metadata', () => {
    expect(() => resolveExplorerRecordIdentity({}, 'Records', { ID: 1 })).toThrow('supported OData version')
    expect(() => resolveExplorerRecordIdentity(schema('v4', []), 'Records', { ID: 1 })).toThrow('no supported key')
    const metadata = schema('v4', [['ID', 'Edm.Int32']])
    expect(() => resolveExplorerRecordIdentity(metadata, 'Record', { ID: 1 })).toThrow('exact metadata')
    metadata.entities.push(metadata.entities[0]!)
    expect(() => resolveExplorerRecordIdentity(metadata, 'Records', { ID: 1 })).toThrow('exact metadata')
  })

  it('rejects key changes while accepting partial payloads and equivalent typed literals', () => {
    const { key } = resolveExplorerRecordIdentity(schema('v4', [['Number', 'Edm.Int64']]), 'Records', { Number: '7' })
    expect(() => assertExplorerKeyUnchanged(key, { Name: 'Partial update' })).not.toThrow()
    expect(() => assertExplorerKeyUnchanged(key, { Number: 7 })).not.toThrow()
    expect(() => assertExplorerKeyUnchanged(key, { Number: 8 })).toThrow('Key changes are not supported')
    expect(() => assertExplorerKeyUnchanged(key, { Number: null })).toThrow('Key changes are not supported')
  })

  it('addresses the declared set without treating a type name as another set', () => {
    const metadata = schema('v4', [['ID', 'Edm.Int32']])
    const entity = { ...metadata.entities[0], name: 'RecordType', entitySet: 'Records' }
    const projection = { ...metadata, entities: [entity] }
    expect(resolveExplorerRecordIdentity(projection, 'Records', { ID: 0 }).entityPath).toBe('Records(0)')
    expect(() => resolveExplorerRecordIdentity(projection, 'RecordType', { ID: 0 })).toThrow('exact metadata')
  })
})
