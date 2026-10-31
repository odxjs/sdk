import type { DockClientScriptContext } from '@vitejs/devtools-kit/client'
import type { DEVTOOLS_TERMINALS_DOCK_ID } from '@vitejs/devtools-kit/constants'

// Keep this activation module import-free at runtime. Loading a new bare
// dependency here could trigger Vite discovery and reload the host page.
const TERMINALS_DOCK_ID: typeof DEVTOOLS_TERMINALS_DOCK_ID = 'devframes_plugin_terminals'

/** A small native dock bootstrap; the Explorer itself retains its Nuxt UI. */
export default function setup(context: DockClientScriptContext): void {
  const descriptor = context.current.entryMeta
  const autoStart = descriptor.type === 'custom-render' && new URL(descriptor.renderer.importFrom, window.location.href).searchParams.get('odxAuto') !== '0'
  let content: HTMLElement | undefined
  let disposed = false
  let pending = false
  let mountFrame: number | undefined
  const disposers: (() => void)[] = []

  function dispose(): void {
    disposed = true
    if (mountFrame !== undefined)
      cancelAnimationFrame(mountFrame)
    content?.remove()
    for (const off of disposers.splice(0))
      off()
  }

  function mount(panel: HTMLDivElement): void {
    if (disposed)
      return
    if (content) {
      if (content.parentElement !== panel)
        panel.append(content)
      return
    }
    const root = document.createElement('section')
    // Hub UI retains custom-render panes across iframe handoffs. Replace only
    // this bootstrap's preceding DOM/controller when setup runs again.
    panel.querySelector(':scope > .odx-explorer-start')?.dispatchEvent(new Event('odx:dispose-start-view'))
    root.className = 'odx-explorer-start'
    root.addEventListener('odx:dispose-start-view', dispose, { once: true })
    const style = document.createElement('style')
    style.textContent = '.odx-explorer-start{display:grid;place-content:center;justify-items:center;gap:1rem;min-height:100%;padding:2rem;text-align:center;font:inherit;color:inherit}.odx-explorer-start h2,.odx-explorer-start p{margin:0}.odx-explorer-start button{font:inherit;color:inherit;border:1px solid currentColor;border-radius:.375rem;background:transparent;padding:.5rem 1rem;cursor:pointer}.odx-explorer-start button:focus-visible{outline:2px solid currentColor;outline-offset:2px}'
    const heading = document.createElement('h2')
    heading.textContent = 'ODX Explorer'
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    status.textContent = autoStart ? 'Starting ODX Explorer…' : 'Use Retry to open the Explorer again.'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = 'Retry'
    retry.hidden = autoStart
    const terminal = document.createElement('button')
    terminal.type = 'button'
    terminal.textContent = 'View in Terminal'
    root.append(style, heading, status, retry, terminal)
    panel.append(root)
    content = root

    async function start(): Promise<void> {
      if (disposed || pending)
        return
      pending = true
      retry.hidden = true
      status.setAttribute('role', 'status')
      status.textContent = 'Starting ODX Explorer…'
      try {
        await context.commands.execute('odx:explorer:start')
        if (!disposed)
          status.textContent = 'If the Explorer is not visible, use Retry.'
      }
      catch {
        if (!disposed) {
          status.setAttribute('role', 'alert')
          status.textContent = 'ODX Explorer could not start. Inspect its terminal, then retry.'
          retry.hidden = false
        }
      }
      finally {
        pending = false
        if (!disposed)
          retry.hidden = false
      }
    }
    retry.addEventListener('click', () => {
      void start()
    })
    terminal.addEventListener('click', async () => {
      try {
        await context.rpc.call('hub:docks:activate', { dockId: TERMINALS_DOCK_ID, params: { sessionId: 'odx:client' } })
      }
      catch {
        if (!disposed) {
          status.setAttribute('role', 'alert')
          status.textContent = 'The terminal could not be opened. Reopen DevTools and retry.'
        }
      }
    })
    if (autoStart)
      void start()
  }

  disposers.push(context.current.events.on('dom:panel:mounted', mount))
  window.addEventListener('pagehide', dispose, { once: true })
  disposers.push(() => window.removeEventListener('pagehide', dispose))
  const deadline = performance.now() + 5000
  function mountWhenReady(): void {
    if (disposed || content)
      return
    if (context.current.domElements.panel)
      mount(context.current.domElements.panel)
    // Pinned Hub UI assigns the public panel ref without always emitting its
    // mounted event. Cover either order without watching viewer internals.
    else if (context.current.isActive && performance.now() < deadline)
      mountFrame = requestAnimationFrame(mountWhenReady)
    else
      context.messages.error('The Explorer start view could not mount. Reopen ODX in DevTools.')
  }
  mountWhenReady()
}
