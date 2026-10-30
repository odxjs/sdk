import { describe, expect, it } from 'vitest'
import { projectExplorerDataMethods } from '../src/utils/explorer-capabilities'

describe('explorer static data-method projection', () => {
  it('intersects allow rules and exclusions using the same case-sensitive method names as the guard', () => {
    expect(projectExplorerDataMethods({ name: 'Catalog', rules: [
      { type: 'allowOnlyMethods', value: ['GET', 'POST', 'PATCH'] },
      { type: 'denyMethods', value: ['PATCH'] },
      { type: 'allowOnlyMethods', value: ['GET', 'PATCH', 'DELETE'] },
    ] })).toEqual(['GET'])
    expect(projectExplorerDataMethods({ name: 'Catalog', rules: [{ type: 'allowOnlyMethods', value: ['get'] }] })).toEqual([])
  })

  it('does not project dynamic authorization rules as a grant of access', () => {
    expect(projectExplorerDataMethods({ name: 'Catalog', rules: [{ type: 'requireScope', value: 'synthetic-private-scope' }] }))
      .toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'MERGE', 'DELETE'])
  })

  it('mirrors the direct bridge contract and fails closed for malformed proxied method rules', () => {
    expect(projectExplorerDataMethods({ name: 'Direct', strategy: 'direct', rules: [{ type: 'allowOnlyMethods', value: ['GET'] }] })).toContain('PATCH')
    expect(projectExplorerDataMethods({ name: 'Catalog', rules: [{ type: 'denyMethods', value: 'POST' }] })).toEqual([])
  })
})
