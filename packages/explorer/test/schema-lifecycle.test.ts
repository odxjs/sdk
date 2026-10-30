import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { useSharedODataState } from '../composables/useODataState'
import { provideSchemaExplorer, useSchemaExplorer } from '../composables/useSchemaExplorer'

describe('schema component ownership', () => {
  it('recreates the rendered graph owner after remount and rejects the old response', async () => {
    const state = useSharedODataState()
    state.selectedService.value = { name: 'Synthetic', route: 'synthetic' } as any
    const schema = { entities: [{ name: 'Products', type: 'Product', properties: [] }] }
    let resolveOld!: (response: Response) => void
    let oldSignal: AbortSignal | null | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockImplementationOnce((_url, options) => {
      oldSignal = options?.signal
      return new Promise(resolve => resolveOld = resolve)
    })
    const controllers: ReturnType<typeof provideSchemaExplorer>[] = []
    const Child = defineComponent({
      setup() {
        const controller = useSchemaExplorer()
        expect(controller).toBe(controllers.at(-1))
        return () => h('div')
      },
    })
    const Owner = defineComponent({
      setup() {
        controllers.push(provideSchemaExplorer())
        return () => h(Child)
      },
    })
    let first: Awaited<ReturnType<typeof mountSuspended>> | undefined
    let second: Awaited<ReturnType<typeof mountSuspended>> | undefined
    try {
      first = await mountSuspended(Owner)
      first.unmount()
      expect(oldSignal?.aborted).toBe(true)
      fetchMock.mockResolvedValue(new Response(JSON.stringify(schema)))
      second = await mountSuspended(Owner)
      await expect.poll(() => controllers[1]!.globalNodes.value.map(node => node.id)).toEqual(['Products'])
      expect(controllers[1]).not.toBe(controllers[0])
      resolveOld(new Response(JSON.stringify({ entities: [{ name: 'Obsolete', properties: [] }] })))
      await Promise.resolve()
      await Promise.resolve()
      expect(controllers[1]!.globalNodes.value.map(node => node.id)).toEqual(['Products'])
    }
    finally {
      second?.unmount()
      first?.unmount()
      fetchMock.mockRestore()
      state.selectedService.value = null
    }
  })
})
