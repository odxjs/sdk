import { describe, expect, it } from 'vitest'
import { createExplorerJSONHeaders, isExplorerWriteMethod } from '../utils/requestTarget'

describe('explorer explicit JSON request contract', () => {
  it('negotiates JSON without duplicate session header casing', () => {
    const session = { 'ACCEPT': 'text/xml', 'content-type': 'text/plain', 'X-Session': 'original' }
    const headers = createExplorerJSONHeaders(session, 'v4')
    session['X-Session'] = 'changed'
    expect(headers).toEqual({ 'Accept': 'application/json;IEEE754Compatible=true', 'Content-Type': 'application/json;IEEE754Compatible=true', 'X-Session': 'original' })
    expect(Object.isFrozen(headers)).toBe(true)
    expect(createExplorerJSONHeaders({}, 'v2').Accept).toBe('application/json')
  })

  it('accepts the explicit write methods including V2 MERGE', () => {
    expect(['POST', 'PUT', 'PATCH', 'MERGE', 'DELETE'].every(isExplorerWriteMethod)).toBe(true)
    expect(['GET', 'HEAD', 'TRACE', 'UNKNOWN', 'post'].some(isExplorerWriteMethod)).toBe(false)
  })
})
