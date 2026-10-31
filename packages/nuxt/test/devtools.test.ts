import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { consola } from 'consola'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupDevToolsUI } from '../src/devtools'
import { createExplorerClientMiddleware } from '../src/devtools-client'

const { addVitePlugin, start, current, stop, dispose, createContributor } = vi.hoisted(() => ({
  addVitePlugin: vi.fn(),
  start: vi.fn(),
  current: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
  createContributor: vi.fn(),
}))
vi.mock('@nuxt/kit', async original => ({ ...await original<typeof import('@nuxt/kit')>(), addVitePlugin }))
vi.mock('@nuxt/devtools-kit', () => ({
  NUXT_DEVTOOLS_GROUP_ID: 'nuxt',
  onDevtoolsReady: (callback: (...args: unknown[]) => unknown, nuxt: any) => nuxt.hook('devtools:ready', callback),
}))
vi.mock('../src/devtools-contributor', () => ({ createExplorerContributor: createContributor }))
vi.mock('../src/devtools-client', () => ({ createExplorerClientMiddleware: vi.fn(async () => vi.fn()) }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: vi.fn() }))

function harness(source = false, hasAssets = true, app: { baseURL: string, buildAssetsDir?: string } = { baseURL: '/console/' }) {
  const hooks = new Map<string, ((...args: any[]) => unknown)[]>()
  const nuxt = {
    options: { app },
    hook: vi.fn((name: string, callback: (...args: any[]) => unknown) => {
      hooks.set(name, [...(hooks.get(name) || []), callback])
    }),
  } as any
  const resolver = { resolve: (path: string) => ({
    './client': '/installed/client',
    './module.ts': '/source/module.ts',
    '../../explorer': '/source/explorer',
    './runtime/devtools/explorer-start.ts': '/source/runtime/devtools/explorer-start.ts',
  }[path] || path) } as any
  vi.mocked(existsSync).mockImplementation(path => source
    ? String(path) === '/source/module.ts' || String(path) === '/source/explorer'
    : hasAssets && String(path).startsWith('/installed/client/'))
  setupDevToolsUI(nuxt, resolver)
  return {
    nuxt,
    async callHook(name: string, ...args: unknown[]) {
      for (const callback of hooks.get(name) || [])
        await callback(...args)
    },
  }
}

function contributorPlugin(): any {
  return addVitePlugin.mock.calls.map(([plugin]) => plugin).find(plugin => plugin.name === 'odx:explorer-contributor')
}

describe('native DevTools integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    current.mockReset().mockReturnValue(undefined)
    start.mockReset().mockImplementation(() => {
      const task = Promise.resolve('http://127.0.0.1:45678')
      current.mockReturnValue(task)
      return task
    })
    stop.mockReset().mockResolvedValue(undefined)
    dispose.mockReset().mockResolvedValue(undefined)
    createContributor.mockReturnValue({ start, current, stop, dispose })
    vi.mocked(createExplorerClientMiddleware).mockResolvedValue(vi.fn())
  })

  it('registers exactly one native installed iframe and mounts assets under the app base', async () => {
    const { nuxt, callHook } = harness()
    const ctx = { docks: { register: vi.fn() }, commands: { register: vi.fn((_command: { handler: () => Promise<void> }) => ({ unregister: vi.fn() })) } }
    const middlewareUse = vi.fn()
    await callHook('vite:serverCreated', { middlewares: { use: middlewareUse } }, { isClient: true })
    expect(createExplorerClientMiddleware).toHaveBeenCalledWith('/installed/client', {
      baseURL: '/console/__odx__/client/',
      apiBase: '/console',
    })
    await callHook('devtools:ready', ctx)
    await callHook('devtools:ready', ctx)
    expect(ctx.docks.register).toHaveBeenCalledExactlyOnceWith({
      id: 'odx',
      title: 'ODX',
      icon: 'lucide:cable',
      type: 'iframe',
      url: '/console/__odx__/client/',
      groupId: 'nuxt',
      category: 'modules',
    }, true)
    expect(nuxt.hook.mock.calls.map(([name]: string[]) => name)).not.toContain('devtools:customTabs')
    expect(createContributor).not.toHaveBeenCalled()
    expect(contributorPlugin()).toBeUndefined()
  })

  it('keeps the host usable when installed assets are incompatible', async () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => undefined)
    try {
      vi.mocked(createExplorerClientMiddleware).mockRejectedValueOnce(new Error('Unsupported manifest'))
      const { callHook } = harness()
      const use = vi.fn()
      await callHook('vite:serverCreated', { middlewares: { use } })
      const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
      use.mock.calls[0]![1]({}, response)
      expect(response.statusCode).toBe(503)
      expect(warn).toHaveBeenCalledOnce()
      expect(start).not.toHaveBeenCalled()
    }
    finally { warn.mockRestore() }
  })

  it('does not mount a second static middleware for the SSR Vite environment', async () => {
    const { callHook } = harness()
    const use = vi.fn()
    await callHook('vite:serverCreated', { middlewares: { use } }, { isClient: false })
    expect(use).not.toHaveBeenCalled()
  })

  it('reports missing installed assets without falling back to a source process', async () => {
    const { callHook } = harness(false, false)
    const use = vi.fn()
    await callHook('vite:serverCreated', { middlewares: { use } })
    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
    use.mock.calls[0]![1]({}, response)
    expect(response.statusCode).toBe(503)
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('assets are missing'))
    expect(createContributor).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('does not launch during prepare or before a native host is ready', async () => {
    const { callHook } = harness(true)
    expect(createContributor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      directory: '/source/explorer',
      baseURL: '/console/_nuxt/odx-explorer/',
      apiBase: '/console',
    }))
    expect(start).not.toHaveBeenCalled()
    await callHook('close')
    expect(dispose).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
  })

  it('registers activation-owned startup and restores a fresh start view after the process stops', async () => {
    const { callHook } = harness(true)
    const ctx = { docks: { register: vi.fn() }, commands: { register: vi.fn((_command: { handler: () => Promise<void> }) => ({ unregister: vi.fn() })) } }
    await callHook('devtools:ready', ctx)
    const launcher = ctx.docks.register.mock.calls[0]![0]
    expect(launcher.type).toBe('custom-render')
    expect(start).not.toHaveBeenCalled()
    expect(JSON.parse(JSON.stringify(launcher)).renderer.importFrom).toBe('/console/_nuxt/@fs//source/runtime/devtools/explorer-start.ts?odxStart=1&odxAuto=1')
    await ctx.commands.register.mock.calls[0]![0].handler()
    expect(start).toHaveBeenCalledOnce()
    expect(ctx.docks.register).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'iframe', url: '/console/_nuxt/odx-explorer/?odxInstance=1' }), true)
    createContributor.mock.calls[0]![0].onStopped()
    expect(ctx.docks.register).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'custom-render', renderer: expect.objectContaining({ importFrom: expect.stringContaining('?odxStart=2') }) }), true)
    await ctx.commands.register.mock.calls[0]![0].handler()
    expect(ctx.docks.register).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'iframe',
      frameId: 'odx:client:2',
      url: '/console/_nuxt/odx-explorer/?odxInstance=2',
    }), true)
    await callHook('close')
    expect(dispose).toHaveBeenCalledOnce()
    expect(ctx.commands.register.mock.results[0]!.value.unregister).toHaveBeenCalledOnce()
  })

  it('proxies the same-origin UI/HMR mount to the discovered port and strips host credentials', async () => {
    harness(true)
    current.mockReturnValue(Promise.resolve('http://127.0.0.1:45678'))
    const plugin = contributorPlugin()
    expect(plugin.apply).toBe('serve')
    const configuration = plugin.config()
    const proxy = configuration.server.proxy['/console/_nuxt/odx-explorer/']
    expect(proxy.ws).toBe(true)
    const emitter = new EventEmitter()
    proxy.configure(emitter, proxy)
    await proxy.bypass({ url: '/console/_nuxt/odx-explorer/_nuxt/test.js' }, {})
    expect(proxy.target).toBe('http://127.0.0.1:45678')
    expect(start).not.toHaveBeenCalled()
    const removeHeader = vi.fn()
    emitter.emit('proxyReq', { removeHeader })
    emitter.emit('proxyReqWs', { removeHeader })
    expect(removeHeader.mock.calls).toEqual([['authorization'], ['cookie'], ['authorization'], ['cookie']])
    expect(Object.keys(configuration.server.proxy)).toEqual(['/console/_nuxt/odx-explorer/'])
  })

  it('returns a bounded HTTP/WS failure if the contributor cannot start', async () => {
    harness(true)
    const proxy = contributorPlugin().config().server.proxy['/console/_nuxt/odx-explorer/']
    proxy.configure(new EventEmitter(), proxy)
    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
    const path = '/console/_nuxt/odx-explorer/'
    expect(await proxy.bypass({ url: path }, response)).toBe(path)
    expect(response.statusCode).toBe(503)
    expect(response.end).toHaveBeenCalledWith('Start the repository Explorer from its Nuxt DevTools launcher.')
    expect(await proxy.bypass({ url: path }, undefined)).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })

  it('gives only the client proxy the public HMR upgrade owner', () => {
    harness(true, true, { baseURL: '/tenant/', buildAssetsDir: '/assets/' })
    const plugin = contributorPlugin()
    expect(addVitePlugin.mock.calls.find(([entry]) => entry === plugin)![1]).toEqual({ server: false })
    expect(Object.keys(plugin.config().server.proxy)).toEqual(['/tenant/assets/odx-explorer/'])
    const server = new EventEmitter()
    const config = { server: { middlewareMode: true, hmr: { server } } }
    plugin.configResolved(config)
    expect(config.server.middlewareMode).toEqual({ server })
    const noListener = { server: { middlewareMode: true, hmr: false } }
    plugin.configResolved(noListener)
    expect(noListener.server.middlewareMode).toBe(true)
  })

  it('keeps contributor failures out of unauthenticated frontend responses', async () => {
    harness(true)
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    try {
      const failure = new Error('Cannot resolve C:/private/source/nuxt/package.json')
      current.mockReturnValue(Promise.reject(failure))
      const proxy = contributorPlugin().config().server.proxy['/console/_nuxt/odx-explorer/']
      proxy.configure(new EventEmitter(), proxy)
      const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
      await proxy.bypass({ url: '/console/_nuxt/odx-explorer/' }, response)
      expect(response.statusCode).toBe(503)
      expect(response.end).toHaveBeenCalledWith('The ODX Explorer is unavailable. Inspect its native terminal and restart it from the DevTools launcher.')
      expect(warn).toHaveBeenCalledWith(expect.any(String), failure)
    }
    finally { warn.mockRestore() }
  })

  it('does not register a replacement dock when host shutdown races with reconnect', async () => {
    const { callHook } = harness(true)
    const old = { docks: { register: vi.fn() }, commands: { register: vi.fn((_command: { handler: () => Promise<void> }) => ({ unregister: vi.fn() })) } }
    const next = { docks: { register: vi.fn() }, commands: { register: vi.fn((_command: { handler: () => Promise<void> }) => ({ unregister: vi.fn() })) } }
    await callHook('devtools:ready', old)
    let resolve!: () => void
    stop.mockReturnValueOnce(new Promise<void>(done => resolve = done))
    const reconnect = callHook('devtools:ready', next)
    await callHook('close')
    resolve()
    await reconnect
    expect(next.docks.register).not.toHaveBeenCalled()
  })

  it('uses late Nuxt loopback discovery without widening a LAN-facing RPC listener', () => {
    const { nuxt } = harness()
    const plugin = addVitePlugin.mock.calls[0]![0]
    expect(plugin.config()).toEqual({})
    nuxt.options.devServer = { host: '127.0.0.1' }
    expect(plugin.config()).toEqual({ server: { host: '127.0.0.1' } })
    nuxt.options.devServer.host = '::1'
    expect(plugin.config()).toEqual({ server: { host: '::1' } })
    nuxt.options.devServer.host = '0.0.0.0'
    expect(plugin.config()).toEqual({})
  })

  it('rejects a launcher belonging to a replaced host before starting any process', async () => {
    const { callHook } = harness(true)
    const previous = { docks: { register: vi.fn() }, commands: { register: vi.fn((_command: { handler: () => Promise<void> }) => ({ unregister: vi.fn() })) } }
    const next = { docks: { register: vi.fn() }, commands: { register: vi.fn((_command: { handler: () => Promise<void> }) => ({ unregister: vi.fn() })) } }
    await callHook('devtools:ready', previous)
    const command = previous.commands.register.mock.calls[0]![0]
    await callHook('devtools:ready', next)
    await expect(command.handler()).rejects.toThrow('host changed')
    expect(start).not.toHaveBeenCalled()
  })

  it('reports a process exiting before its iframe can be registered', async () => {
    const { callHook } = harness(true)
    const ctx = { docks: { register: vi.fn() }, commands: { register: vi.fn((_command: { handler: () => Promise<void> }) => ({ unregister: vi.fn() })) } }
    await callHook('devtools:ready', ctx)
    start.mockResolvedValueOnce('http://127.0.0.1:45678')
    await expect(ctx.commands.register.mock.calls[0]![0].handler()).rejects.toThrow('stopped during startup')
    expect(ctx.docks.register).toHaveBeenCalledOnce()
  })
})
