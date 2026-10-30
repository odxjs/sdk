import { describe, expect, it, vi } from 'vitest'
import { createApp, h, onScopeDispose, ref, watch } from 'vue'
import { useExplorerPolling } from '../composables/useExplorerPolling'
import { createAppState } from '../utils/appState'
import { createLatestRequest } from '../utils/latestRequest'

describe('explorer app ownership', () => {
  it('pauses polling while hidden, reconciles on return and stops on unmount', () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('visible')
    const refresh = vi.fn(async () => {})
    const app = createApp({
      setup() {
        useExplorerPolling(refresh)
        return () => h('div')
      },
    })
    try {
      app.mount(document.createElement('div'))
      expect(refresh).toHaveBeenCalledTimes(1)
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(9000)
      expect(refresh).toHaveBeenCalledTimes(1)
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(refresh).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(3000)
      expect(refresh).toHaveBeenCalledTimes(3)
      app.unmount()
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(9000)
      expect(refresh).toHaveBeenCalledTimes(3)
    }
    finally {
      visibility.mockRestore()
      vi.useRealTimers()
    }
  })

  it('pauses in a retained host pane and reconciles only when interaction returns', async () => {
    vi.useFakeTimers()
    const frame = document.createElement('iframe')
    frame.style.pointerEvents = 'none'
    document.body.appendChild(frame)
    const owner = Object.getOwnPropertyDescriptor(window, 'frameElement')
    // happy-dom omits the browser's frameElement property.
    Object.defineProperty(window, 'frameElement', { configurable: true, get: () => frame })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const refresh = vi.fn(async () => {})
    const app = createApp({
      setup() {
        useExplorerPolling(refresh)
        return () => h('div')
      },
    })
    try {
      app.mount(document.createElement('div'))
      await vi.advanceTimersByTimeAsync(9000)
      expect(refresh).not.toHaveBeenCalled()
      frame.style.pointerEvents = 'auto'
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1), { timeout: 200, interval: 10 })
      // Active resizing/style changes must not dispatch additional reads.
      frame.style.width = '500px'
      await vi.advanceTimersByTimeAsync(0)
      expect(refresh).toHaveBeenCalledTimes(1)
      frame.style.pointerEvents = 'none'
      await vi.advanceTimersByTimeAsync(9000)
      expect(refresh).toHaveBeenCalledTimes(1)
      frame.style.pointerEvents = 'auto'
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2), { timeout: 200, interval: 10 })
      app.unmount()
      frame.style.pointerEvents = 'none'
      frame.style.pointerEvents = 'auto'
      await vi.advanceTimersByTimeAsync(9000)
      expect(refresh).toHaveBeenCalledTimes(2)
    }
    finally {
      app.unmount()
      frame.remove()
      if (owner)
        Object.defineProperty(window, 'frameElement', owner)
      else
        Reflect.deleteProperty(window, 'frameElement')
      visibility.mockRestore()
      vi.useRealTimers()
    }
  })

  it('shares one controller per app, isolates apps and disposes their effects and requests', () => {
    const changed = vi.fn()
    const disposed = vi.fn()
    const getState = createAppState(() => {
      const value = ref(0)
      const requests = createLatestRequest()
      watch(value, changed, { flush: 'sync' })
      onScopeDispose(disposed)
      return { value, requests }
    })
    const firstApp = createApp({ render: () => h('div') })
    const secondApp = createApp({ render: () => h('div') })
    firstApp.mount(document.createElement('div'))
    secondApp.mount(document.createElement('div'))
    const first = getState(firstApp)
    const second = getState(secondApp)
    expect(getState(firstApp)).toBe(first)
    expect(second).not.toBe(first)
    const firstRead = first.requests.begin()
    const secondRead = second.requests.begin()
    first.value.value++
    expect(changed).toHaveBeenCalledTimes(1)
    expect(second.value.value).toBe(0)
    firstApp.unmount()
    expect(firstRead.signal.aborted).toBe(true)
    expect(firstRead.isCurrent()).toBe(false)
    expect(secondRead.isCurrent()).toBe(true)
    first.value.value++
    expect(changed).toHaveBeenCalledTimes(1)
    secondApp.unmount()
    expect(secondRead.signal.aborted).toBe(true)
    expect(disposed).toHaveBeenCalledTimes(2)
  })
})
