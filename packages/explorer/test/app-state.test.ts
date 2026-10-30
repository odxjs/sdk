import { describe, expect, it, vi } from 'vitest'
import { createApp, h, onScopeDispose, ref, watch } from 'vue'
import { createAppState } from '../utils/appState'
import { createLatestRequest } from '../utils/latestRequest'

describe('explorer app ownership', () => {
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
