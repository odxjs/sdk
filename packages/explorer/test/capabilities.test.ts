import { describe, expect, it } from 'vitest'
import { permitsExplorerDataMethod } from '../utils/capabilities'

describe('explorer advisory method capabilities', () => {
  it('blocks methods explicitly excluded by the host and malformed projections', () => {
    const service = { capabilities: { dataMethods: ['GET', 'MERGE'] } }
    expect(permitsExplorerDataMethod(service, 'GET')).toBe(true)
    expect(permitsExplorerDataMethod(service, 'MERGE')).toBe(true)
    expect(permitsExplorerDataMethod(service, 'PATCH')).toBe(false)
    expect(permitsExplorerDataMethod({ capabilities: { dataMethods: 'GET' } }, 'POST')).toBe(false)
    expect(permitsExplorerDataMethod(null, 'GET')).toBe(false)
  })

  it('retains layer-host compatibility when a static projection is absent', () => {
    expect(permitsExplorerDataMethod({}, 'PATCH')).toBe(true)
  })
})
