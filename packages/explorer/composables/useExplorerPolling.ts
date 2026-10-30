import { onMounted, onScopeDispose } from 'vue'

/** The app owns one timer; a hidden iframe pauses reads and reconciles on return. */
export function useExplorerPolling(refresh: () => Promise<void>): void {
  let interval: ReturnType<typeof setInterval> | undefined
  function refreshIfVisible(): void {
    if (document.visibilityState !== 'hidden')
      void refresh()
  }

  onMounted(() => {
    refreshIfVisible()
    interval = setInterval(refreshIfVisible, 3000)
    document.addEventListener('visibilitychange', refreshIfVisible)
  })
  onScopeDispose(() => {
    if (interval !== undefined)
      clearInterval(interval)
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', refreshIfVisible)
  })
}
