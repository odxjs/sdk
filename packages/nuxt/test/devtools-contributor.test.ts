import type { ExplorerDevtoolsContext } from '../src/devtools-contributor'
import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createExplorerContributor } from '../src/devtools-contributor'

const require = createRequire(import.meta.url)
const kitRequire = createRequire(require.resolve('@vitejs/devtools-kit/package.json'))
const { DevframeTerminalsHost } = await import(pathToFileURL(kitRequire.resolve('@devframes/hub/node')).href)
const directory = fileURLToPath(new URL('../../explorer', import.meta.url))
const fixture = fileURLToPath(new URL('fixtures/explorer-terminal.mjs', import.meta.url))

function nativeHost(extraEnv: Record<string, string> = {}) {
  // Real terminal implementation, with no RPC/network host needed. Only the
  // command is substituted: two tiny HTTP clients instead of two Nuxt builds.
  const native = new DevframeTerminalsHost({}) as ExplorerDevtoolsContext['terminals']
  const spawn = vi.fn(async (options, terminal) => native.startChildProcess({
    command: process.execPath,
    args: [fixture],
    cwd: directory,
    env: { ...options.env, ...extraEnv },
  }, terminal))
  const context = { terminals: {
    ...native,
    startChildProcess: spawn,
    remove: native.remove.bind(native),
  } } as unknown as ExplorerDevtoolsContext
  return { native, context, spawn }
}

function contributor(host: ReturnType<typeof nativeHost>, baseURL = '/console/__odx__/client/') {
  const onStopped = vi.fn()
  const controller = createExplorerContributor({ directory, baseURL, apiBase: '/console', context: () => host.context, onStopped })
  return { controller, onStopped }
}

async function cleanup(host: ReturnType<typeof nativeHost>): Promise<void> {
  for (const session of host.native.sessions.values()) {
    if ('terminate' in session)
      await (session as Awaited<ReturnType<typeof host.native.startChildProcess>>).terminate()
    host.native.remove(session)
  }
}

describe('contributor native terminal lifecycle', () => {
  it('coalesces requests, discovers independent actual ports and disposes both real clients', async () => {
    const first = nativeHost()
    const second = nativeHost()
    const a = contributor(first)
    const b = contributor(second, '/other/__odx__/client/')
    let firstOrigin = ''
    let secondOrigin = ''
    try {
      const pending = a.controller.start()
      expect(a.controller.current()).toBe(pending)
      expect(a.controller.start()).toBe(pending)
      firstOrigin = await pending
      secondOrigin = await b.controller.start()
      expect(firstOrigin).not.toBe(secondOrigin)
      expect(first.spawn).toHaveBeenCalledOnce()
      expect(first.spawn.mock.calls[0]![0].args.slice(-2)).toEqual(['--port', '0'])
      expect(first.spawn.mock.calls[0]![1].restartable).toBe(false)
      expect(first.native.sessions.size).toBe(1)
      const state = await fetch(`${firstOrigin}/console/__odx__/client/status`).then(response => response.json())
      expect(state).toMatchObject({ base: '/console/__odx__/client/', apiBase: '/console', legacyTarget: '' })
      await a.controller.dispose()
      await b.controller.dispose()
      expect(a.controller.current()).toBeUndefined()
      expect(first.native.sessions.size).toBe(0)
      expect(second.native.sessions.size).toBe(0)
      await expect(fetch(firstOrigin)).rejects.toThrow()
      await expect(fetch(secondOrigin)).rejects.toThrow()
      await expect(a.controller.start()).rejects.toThrow('closed')
    }
    finally {
      await a.controller.dispose()
      await b.controller.dispose()
      await cleanup(first)
      await cleanup(second)
    }
  })

  it('closes a native process created after its Nuxt host has already begun disposal', async () => {
    const host = nativeHost()
    const original = host.context.terminals.startChildProcess
    let release!: () => void
    const gate = new Promise<void>(resolve => release = resolve)
    host.context.terminals.startChildProcess = async (...args) => {
      await gate
      return original(...args)
    }
    const { controller } = contributor(host)
    const pending = controller.start()
    const failure = expect(pending).rejects.toThrow('stopped')
    const closing = controller.dispose()
    release()
    try {
      await closing
      await failure
      expect(host.native.sessions.size).toBe(0)
    }
    finally {
      await controller.dispose()
      await cleanup(host)
    }
  })

  it('rejects promptly when a process exits after announcing its port but before readiness', async () => {
    const host = nativeHost({ ODX_TEST_EXIT_AFTER_ANNOUNCE: '1', ODX_TEST_READY_DELAY_MS: '10000' })
    const { controller } = contributor(host)
    try {
      await expect(controller.start()).rejects.toThrow(/exited/)
      await expect.poll(() => host.native.sessions.size).toBe(0)
    }
    finally {
      await controller.dispose()
      await cleanup(host)
    }
  })

  it('restores launch availability after native termination and starts a fresh session', async () => {
    const host = nativeHost()
    const { controller } = contributor(host)
    try {
      await controller.start()
      const session = host.native.sessions.get('odx:client') as Awaited<ReturnType<typeof host.native.startChildProcess>>
      await session.terminate()
      await controller.start()
      expect(host.spawn).toHaveBeenCalledTimes(2)
      expect(host.native.sessions.size).toBe(1)
    }
    finally {
      await controller.dispose()
      await cleanup(host)
    }
  })

  it('rejects an invalid announced port without waiting for readiness and reaps its process', async () => {
    const host = nativeHost({ ODX_TEST_ANNOUNCE_PORT: '99999' })
    const { controller } = contributor(host)
    try {
      await expect(controller.start()).rejects.toThrow('invalid loopback port')
      await expect.poll(() => host.native.sessions.size).toBe(0)
    }
    finally {
      await controller.dispose()
      await cleanup(host)
    }
  })

  it('removes a failed termination registration and allows a fresh start', async () => {
    const host = nativeHost()
    const { controller } = contributor(host)
    try {
      const origin = await controller.start()
      const session = host.native.sessions.get('odx:client') as Awaited<ReturnType<typeof host.native.startChildProcess>>
      const terminate = session.terminate.bind(session)
      session.terminate = async () => {
        await terminate()
        throw new Error('Synthetic termination cleanup failure')
      }
      await expect(controller.stop()).rejects.toThrow('Synthetic termination cleanup failure')
      expect(host.native.sessions.size).toBe(0)
      await expect(fetch(origin)).rejects.toThrow()
      await controller.start()
      expect(host.spawn).toHaveBeenCalledTimes(2)
    }
    finally {
      await controller.dispose()
      await cleanup(host)
    }
  })

  it('does not create a process without a native host', async () => {
    const controller = createExplorerContributor({ directory, baseURL: '/__odx__/client/', apiBase: '', context: () => undefined, onStopped: vi.fn() })
    await expect(controller.start()).rejects.toThrow('active Nuxt DevTools v4')
    await controller.dispose()
  })
})
