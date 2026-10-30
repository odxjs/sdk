import { onScopeDispose } from 'vue'

/** Abort obsolete reads and reject late results even when a transport ignores abort. */
export function createLatestRequest(): {
  cancel: () => void
  begin: () => { signal: AbortSignal, isCurrent: () => boolean }
} {
  let controller: AbortController | undefined
  let disposed = false

  function cancel(): void {
    controller?.abort()
    controller = undefined
  }

  onScopeDispose(() => {
    disposed = true
    cancel()
  })

  return {
    cancel,
    begin() {
      cancel()
      const request = new AbortController()
      controller = request
      if (disposed)
        request.abort()
      return {
        signal: request.signal,
        isCurrent: () => !disposed && controller === request && !request.signal.aborted,
      }
    },
  }
}
