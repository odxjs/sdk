import { describe, expect, it } from 'vitest'
import { readExplorerRequestError } from '../utils/requestError'

describe('explorer request failures', () => {
  it.each([
    { status: 412, body: { error: { message: { lang: 'en', value: 'V2 stale record' } } }, message: 'V2 stale record' },
    { status: 409, body: { data: { error: { message: 'V4 lock conflict' } } }, message: 'V4 lock conflict' },
    { status: 428, body: { message: 'An ETag is required' }, message: 'An ETag is required' },
  ])('retains HTTP $status and the protocol error message', async ({ status, body, message }) => {
    const error = await readExplorerRequestError(new Response(JSON.stringify(body), { status }))
    expect(error.status).toBe(status)
    expect(error.conflict).toBe(true)
    expect(error.message).toContain(message)
    expect(error.message).toContain('Reload data before retrying')
  })

  it('retains a non-conflict failure without treating a service outage as a stale record', async () => {
    const error = await readExplorerRequestError(new Response('Synthetic unavailable', { status: 503 }))
    expect(error.conflict).toBe(false)
    expect(error.message).toBe('Request failed (HTTP 503). Synthetic unavailable')
  })

  it('retains conflict status and reload guidance when an XML error cannot be decoded as JSON', async () => {
    const error = await readExplorerRequestError(new Response(`<error>${'long XML detail '.repeat(30)}</error>`, { status: 412 }))
    expect(error.status).toBe(412)
    expect(error.conflict).toBe(true)
    expect(error.message).toContain('Reload data before retrying')
  })
})
