import { onMounted, onScopeDispose } from 'vue'

/** One app-owned timer, including CSS-hidden same-origin host panes. */
export function useExplorerPolling(refresh: () => Promise<void>): void {
  let interval: ReturnType<typeof setInterval> | undefined
  let frame: Element | null = null
  let observer: MutationObserver | undefined
  let wasVisible = false
  let disposed = false

  function isVisible(): boolean {
    if (disposed || document.visibilityState === 'hidden')
      return false
    if (!frame)
      return true
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame)
    // Host panes can remain rendered and document-visible while inactive.
    // Read the actual frame's interaction state, without Devframe internals or
    // opacity thresholds. Cross-origin frameElement is null and stays isolated.
    return !frame.closest('[inert]')
      && style?.pointerEvents !== 'none'
      && (typeof frame.checkVisibility !== 'function' || frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
  }

  function refreshIfVisible(): void {
    wasVisible = isVisible()
    if (wasVisible)
      void refresh()
  }

  function reconcile(): void {
    const visible = isVisible()
    if (visible && !wasVisible)
      void refresh()
    wasVisible = visible
  }

  onMounted(() => {
    frame = window.frameElement
    if (frame) {
      observer = new MutationObserver(reconcile)
      for (let owner: Element | null = frame; owner; owner = owner.parentElement)
        observer.observe(owner, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'] })
    }
    reconcile()
    interval = setInterval(refreshIfVisible, 3000)
    document.addEventListener('visibilitychange', reconcile)
  })
  onScopeDispose(() => {
    disposed = true
    observer?.disconnect()
    if (interval !== undefined)
      clearInterval(interval)
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', reconcile)
  })
}
