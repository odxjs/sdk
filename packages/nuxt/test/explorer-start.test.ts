// @vitest-environment happy-dom
import type { DockClientScriptContext } from '@vitejs/devtools-kit/client'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import setup from '../src/runtime/devtools/explorer-start'

function harness(mounted = true, autoStart = true) {
  const events = new EventEmitter()
  const panel = document.createElement('div')
  document.body.append(panel)
  const execute = vi.fn().mockResolvedValue(undefined)
  const rpc = vi.fn().mockResolvedValue(undefined)
  const context = {
    commands: { execute },
    rpc: { call: rpc },
    current: {
      isActive: true,
      entryMeta: { id: 'odx', type: 'custom-render', renderer: { importFrom: `/start.ts?attempt=1&odxAuto=${autoStart ? '1' : '0'}` } },
      domElements: { panel: mounted ? panel : undefined },
      events: { on: (name: string, callback: (...args: unknown[]) => void) => {
        events.on(name, callback)
        return () => {
          events.off(name, callback)
        }
      } },
    },
  } as unknown as DockClientScriptContext
  return { context, panel, events, execute, rpc }
}

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  document.body.replaceChildren()
})

describe('native Explorer activation', () => {
  it('does not automatically undo an explicit process stop', async () => {
    const { context, panel, execute } = harness(true, false)
    setup(context)
    expect(execute).not.toHaveBeenCalled()
    const retry = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Retry')!
    expect(retry.hidden).toBe(false)
    retry.click()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
  })
  it('starts only when its selected dock receives a panel and coalesces repeated mounts', () => {
    const { context, panel, events, execute } = harness(false)
    execute.mockReturnValue(new Promise(() => {}))
    setup(context)
    expect(execute).not.toHaveBeenCalled()
    events.emit('dom:panel:mounted', panel)
    events.emit('dom:panel:mounted', panel)
    expect(execute).toHaveBeenCalledExactlyOnceWith('odx:explorer:start')
    expect(panel.querySelector('[role=status]')?.textContent).toBe('Starting ODX Explorer…')
  })

  it('shows a safe recoverable failure and retries only on explicit user intent', async () => {
    const { context, panel, execute } = harness()
    execute.mockRejectedValueOnce(new Error('C:/private/access-token')).mockResolvedValue(undefined)
    setup(context)
    await vi.waitFor(() => expect(panel.querySelector('[role=alert]')).not.toBeNull())
    expect(panel.textContent).not.toContain('access-token')
    const retry = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Retry')!
    expect(retry.hidden).toBe(false)
    retry.click()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(retry.hidden).toBe(false)
  })

  it('leaves the host-owned iframe intact when an obsolete request fails late', async () => {
    const { context, panel, events, execute } = harness()
    let reject!: (error: Error) => void
    execute.mockReturnValue(new Promise((_, fail) => reject = fail))
    setup(context)
    events.emit('entry:updated', { type: 'iframe' })
    panel.textContent = 'Current Explorer iframe'
    reject(new Error('late obsolete failure'))
    await Promise.resolve()
    expect(panel.textContent).toBe('Current Explorer iframe')
    expect(panel.querySelector('[role=alert]')).toBeNull()
  })

  it('opens the native terminal using the existing authorized hub action', async () => {
    const { context, panel, rpc } = harness()
    setup(context)
    const terminal = [...panel.querySelectorAll('button')].find(button => button.textContent === 'View in Terminal')!
    terminal.click()
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('hub:docks:activate', { dockId: 'devframes_plugin_terminals', params: { sessionId: 'odx:client' } }))
  })
})
