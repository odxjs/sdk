import type { App, EffectScope } from 'vue'
import { effectScope } from 'vue'

/** Share effects within one Explorer app, with the same lifetime as that app. */
export function createAppState<T>(create: () => T): (app: App) => T {
  const states = new WeakMap<App, T>()
  const scopes = new Set<EffectScope>()

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      for (const scope of scopes)
        scope.stop()
      scopes.clear()
    })
  }

  return (app) => {
    if (states.has(app))
      return states.get(app)!

    const scope = effectScope(true)
    let state: T
    try {
      state = scope.run(create)!
    }
    catch (error) {
      scope.stop()
      throw error
    }
    states.set(app, state)
    scopes.add(scope)
    app.onUnmount(() => {
      scope.stop()
      scopes.delete(scope)
      states.delete(app)
    })
    return state
  }
}
