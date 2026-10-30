import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import authPlugin from '../src/plugins/auth-btp'

const auth = vi.hoisted(() => ({ validate: vi.fn(), context: { synthetic: true } }))
vi.mock('@sap/xsenv', () => ({ default: { serviceCredentials: () => ({ clientid: 'synthetic' }) } }))
vi.mock('@sap/xssec', () => ({ XsuaaService: class {}, createSecurityContext: auth.validate }))
vi.mock('nitropack/runtime', () => ({
  defineNitroPlugin: (plugin: unknown) => plugin,
  useRuntimeConfig: () => ({ app: { baseURL: '/console/' } }),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  auth.validate.mockReset()
})

describe('sap authentication application base', () => {
  it.each([
    ['/console/api/odx/Catalog/Products', true],
    ['/console/__odx__/config', true],
    ['/api/odx/Catalog/Products', true],
    ['/console-other/api/odx/Catalog/Products', false],
    ['/console/public', false],
  ])('keeps authentication on the mounted protected route: %s', async (path, protectedRoute) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VCAP_SERVICES', 'synthetic-binding')
    auth.validate.mockResolvedValue(auth.context)
    let requestHook!: (event: H3Event) => Promise<void>
    authPlugin({
      hooks: {
        hook(_name: string, callback: typeof requestHook) {
          requestHook = callback
        },
      },
    } as any)
    const event = { path, node: { req: {} }, context: {} } as unknown as H3Event
    await requestHook(event)
    expect(auth.validate).toHaveBeenCalledTimes(protectedRoute ? 1 : 0)
    expect(event.context.securityContext).toBe(protectedRoute ? auth.context : undefined)
    expect(event.path).toBe(path)
  })
})
