import { existsSync } from 'node:fs'
import { consola } from 'consola'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVTOOLS_UI_LOCAL_PORT, DEVTOOLS_UI_ROUTE, setupDevToolsUI } from '../src/devtools'
import { createExplorerClientMiddleware } from '../src/devtools-client'

const { startSubprocess } = vi.hoisted(() => ({
  startSubprocess: vi.fn(),
}))

vi.mock('@nuxt/devtools-kit', () => ({
  startSubprocess,
}))

vi.mock('../src/devtools-client', () => ({
  createExplorerClientMiddleware: vi.fn(async () => vi.fn()),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(),
  }
})

function createNuxtHarness() {
  type NuxtHookCallback = (payload?: unknown) => void | Promise<void>
  const hooks = new Map<string, NuxtHookCallback[]>()
  const nuxt = {
    options: {
      nitro: {},
    },
    hook: vi.fn((name: string, callback: NuxtHookCallback) => {
      hooks.set(name, [...(hooks.get(name) || []), callback])
    }),
  } as any

  return {
    nuxt,
    async callHook(name: string, payload?: unknown) {
      for (const callback of hooks.get(name) || [])
        await callback(payload)
    },
  }
}

describe('devtools UI integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the host usable when emitted client metadata is incompatible', async () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => undefined)
    try {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(createExplorerClientMiddleware).mockRejectedValueOnce(new Error('Unsupported fixture manifest'))
      const { nuxt, callHook } = createNuxtHarness()
      setupDevToolsUI(nuxt, { resolve: (path: string) => path } as any)
      const middlewareUse = vi.fn()
      await expect(callHook('vite:serverCreated', { middlewares: { use: middlewareUse } })).resolves.toBeUndefined()
      const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
      middlewareUse.mock.calls[0]![1]({}, response)
      expect(response.statusCode).toBe(503)
      expect(warn).toHaveBeenCalledOnce()
      expect(startSubprocess).not.toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })

  it('defers the explorer dev server until Vite is serving', async () => {
    vi.mocked(existsSync).mockImplementation(path => path === '/repo/packages/explorer' || path === './module.ts')

    const resolver = {
      resolve: vi.fn((path: string) => {
        if (path === './client')
          return '/repo/packages/nuxt/client'
        if (path === '../../explorer')
          return '/repo/packages/explorer'
        return path
      }),
    } as any
    const { nuxt, callHook } = createNuxtHarness()

    setupDevToolsUI(nuxt, resolver)

    expect(startSubprocess).not.toHaveBeenCalled()
    const middlewareUse = vi.fn()
    await callHook('vite:serverCreated', { middlewares: { use: middlewareUse } })
    expect(middlewareUse).toHaveBeenCalledWith(DEVTOOLS_UI_ROUTE, expect.any(Function))

    expect(startSubprocess).toHaveBeenCalledTimes(1)
    expect(startSubprocess).toHaveBeenCalledWith(
      {
        command: 'pnpm',
        args: ['exec', 'nuxi', 'dev', '--host', 'localhost', '--port', DEVTOOLS_UI_LOCAL_PORT.toString()],
        cwd: '/repo/packages/explorer',
        env: {
          ODX_EXPLORER_API_PROXY_TARGET: 'http://localhost:3000',
        },
      },
      {
        id: 'odx:client',
        name: 'ODX Explorer Dev',
      },
    )
  })

  it('mounts an emitted client under the application base without launching a child server', async () => {
    vi.mocked(existsSync).mockImplementation(path => String(path).startsWith('/installed/client/'))
    const resolver = { resolve: (path: string) => path === './client' ? '/installed/client' : path } as any
    const { nuxt, callHook } = createNuxtHarness()
    nuxt.options.app = { baseURL: '/console/' }
    setupDevToolsUI(nuxt, resolver)
    const middlewareUse = vi.fn()
    await callHook('vite:serverCreated', { middlewares: { use: middlewareUse } })
    expect(createExplorerClientMiddleware).toHaveBeenCalledWith('/installed/client', {
      baseURL: '/console/__odx__/client/',
      apiBase: '/console',
    })
    expect(middlewareUse).toHaveBeenCalledWith('/console/__odx__/client', expect.any(Function))
    expect(startSubprocess).not.toHaveBeenCalled()
    const tabs: unknown[] = []
    await callHook('devtools:customTabs', tabs)
    expect(tabs).toEqual([expect.objectContaining({ view: { type: 'iframe', src: '/console/__odx__/client/' } })])
  })

  it('reports missing installed assets without falling back to a child process', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const resolver = { resolve: (path: string) => path } as any
    const { nuxt, callHook } = createNuxtHarness()
    setupDevToolsUI(nuxt, resolver)
    const middlewareUse = vi.fn()
    await callHook('vite:serverCreated', { middlewares: { use: middlewareUse } })
    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
    middlewareUse.mock.calls[0]![1]({}, response)
    expect(response.statusCode).toBe(503)
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('assets are missing'))
    expect(startSubprocess).not.toHaveBeenCalled()
  })
})
