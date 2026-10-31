import type { Resolver } from '@nuxt/kit'
import type { Nuxt } from 'nuxt/schema'
import type { ProxyOptions } from 'vite'
import type { ExplorerDevtoolsContext } from './devtools-contributor'
import { existsSync } from 'node:fs'
import { NUXT_DEVTOOLS_GROUP_ID, onDevtoolsReady } from '@nuxt/devtools-kit'
import { addVitePlugin } from '@nuxt/kit'
import { consola } from 'consola'
import { createExplorerClientMiddleware } from './devtools-client'
import { createExplorerContributor } from './devtools-contributor'

export const DEVTOOLS_UI_ROUTE = '/__odx__/client'
const RE_TRAILING_SLASH = /\/$/
const ASSETS_UNAVAILABLE = 'ODX Explorer assets are missing or incompatible. Rebuild the coordinated Explorer and Nuxt packages; installed applications do not start a separate UI server.'

function unavailableClient(_request: unknown, response: { statusCode: number, setHeader: (name: string, value: string) => unknown, end: (body: string) => unknown }): void {
  response.statusCode = 503
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.end(ASSETS_UNAVAILABLE)
}

export function setupDevToolsUI(nuxt: Nuxt, resolver: Resolver): void {
  // Nuxt resolves its listener after module setup. Read its public host at
  // Vite configuration time so the RPC sidecar uses the same loopback family.
  // Do not widen the sidecar's binding for LAN-facing application servers.
  addVitePlugin({
    name: 'odx:devtools-loopback-host',
    apply: 'serve',
    config() {
      const host = nuxt.options.devServer?.host
      return host === '127.0.0.1' || host === '::1' ? { server: { host } } : {}
    },
  })
  const clientPath = resolver.resolve('./client')
  const hasStaticClient = existsSync(`${clientPath}/manifest.json`) && existsSync(`${clientPath}/index.html`)
  const explorerDirectory = resolver.resolve('../../explorer')
  const isContributor = !hasStaticClient && existsSync(resolver.resolve('./module.ts')) && existsSync(explorerDirectory)
  const appBase = `/${(nuxt.options.app?.baseURL || '/').split('/').filter(Boolean).join('/')}`.replace(RE_TRAILING_SLASH, '')
  // Nuxt's CLI reserves upgrades under its asset mount for Vite. A source
  // client outside it would also reach Nitro's catch-all upgrade handler.
  const assetRoute = (nuxt.options.app?.buildAssetsDir || '/_nuxt/').split('/').filter(Boolean).join('/')
  const mountedRoute = isContributor ? `${appBase}/${assetRoute}/odx-explorer` : `${appBase}${DEVTOOLS_UI_ROUTE}`
  const baseURL = `${mountedRoute}/`
  const dock = { id: 'odx', title: 'ODX', icon: 'lucide:cable', groupId: NUXT_DEVTOOLS_GROUP_ID, category: 'modules' as const }
  let disposed = false
  let context: ExplorerDevtoolsContext | undefined
  let launchCommand: ReturnType<ExplorerDevtoolsContext['commands']['register']> | undefined
  let clientOrigin: string | undefined
  let clientGeneration = 0
  let startViewGeneration = 0
  const contributor = isContributor
    ? createExplorerContributor({
        directory: explorerDirectory,
        baseURL,
        apiBase: appBase,
        context: () => context,
        onStopped: () => {
          clientOrigin = undefined
          if (context && !disposed)
            registerStartView(context, false)
        },
      })
    : undefined

  function registerIframe(ctx: ExplorerDevtoolsContext, origin?: string): void {
    if (origin && origin !== clientOrigin) {
      clientOrigin = origin
      clientGeneration++
    }
    // The viewer retains visited frames. A fresh process must load its fresh
    // Vite client/token rather than reuse the preceding process's document.
    const url = origin ? `${baseURL}?odxInstance=${clientGeneration}` : baseURL
    const frame = origin ? { frameId: `odx:client:${clientGeneration}` } : {}
    ctx.docks.register({ ...dock, ...frame, type: 'iframe', url }, true)
  }

  function registerStartView(ctx: ExplorerDevtoolsContext, autoStart = true): void {
    const scriptPath = encodeURI(resolver.resolve('./runtime/devtools/explorer-start.ts').replaceAll('\\', '/')).replaceAll('#', '%23').replaceAll('?', '%3F')
    ctx.docks.register({
      ...dock,
      type: 'custom-render',
      renderer: {
        // Each stopped process gets a fresh setup; Devframe caches scripts by
        // descriptor. Importing this view does not run before dock activation.
        importFrom: `${appBase}/${assetRoute}/@fs/${scriptPath}?odxStart=${++startViewGeneration}&odxAuto=${autoStart ? '1' : '0'}`,
      },
    }, true)
  }

  onDevtoolsReady(async (ctx) => {
    if (disposed || context === ctx)
      return
    const previous = context
    context = ctx
    clientOrigin = undefined
    launchCommand?.unregister()
    launchCommand = undefined
    if (previous)
      await contributor?.stop()
    if (disposed || context !== ctx)
      return
    if (contributor) {
      // A function on a dock entry is dropped by shared-state serialization.
      // Bind the viewer's launch action to an authenticated host command.
      launchCommand = ctx.commands.register({
        id: 'odx:explorer:start',
        title: 'Start ODX Explorer',
        async handler() {
          if (disposed || context !== ctx)
            throw new Error('The ODX host changed. Open its current Explorer launcher.')
          const origin = await contributor.start()
          if (!disposed && context === ctx && contributor.current())
            registerIframe(ctx, origin)
          else if (!disposed && context === ctx)
            throw new Error('The ODX Explorer stopped during startup. Inspect its terminal and retry.')
        },
      })
      registerStartView(ctx)
    }
    else {
      registerIframe(ctx)
    }
  }, nuxt)

  nuxt.hook('close', async () => {
    disposed = true
    launchCommand?.unregister()
    launchCommand = undefined
    await contributor?.dispose()
    context = undefined
  })

  if (contributor) {
    // Vite owns HTTP/websocket cleanup. APIs outside this mount keep the host's
    // existing cookies, authentication and OData transport policy.
    addVitePlugin({
      name: 'odx:explorer-contributor',
      apply: 'serve',
      configResolved(config) {
        const hmr = config.server.hmr
        // Nuxt supplies its listener through public HMR options, but runs Vite
        // in middleware mode. Give Vite's WS proxy that same upgrade owner.
        if (config.server.middlewareMode && hmr && typeof hmr === 'object' && hmr.server)
          config.server.middlewareMode = { server: hmr.server }
      },
      config() {
        let setTarget: (origin: string) => void
        const proxy: ProxyOptions = {
          target: 'http://127.0.0.1:1',
          changeOrigin: true,
          ws: true,
          configure(proxy, proxyOptions) {
            setTarget = (origin) => {
              proxyOptions.target = origin
            }
            proxy.on('proxyReq', (request) => {
              request.removeHeader('authorization')
              request.removeHeader('cookie')
            })
            proxy.on('proxyReqWs', (request) => {
              request.removeHeader('authorization')
              request.removeHeader('cookie')
            })
          },
          async bypass(request, response) {
            const current = contributor.current()
            try {
              if (!current)
                throw new Error('Start the repository Explorer from its Nuxt DevTools launcher.')
              setTarget(await current)
            }
            catch (error) {
              if (current)
                consola.warn('[ODX] The contributor client is unavailable. Inspect its native terminal.', error)
              if (!response)
                return false
              response.statusCode = 503
              response.setHeader('Content-Type', 'text/plain; charset=utf-8')
              response.end(current
                ? 'The ODX Explorer is unavailable. Inspect its native terminal and restart it from the DevTools launcher.'
                : 'Start the repository Explorer from its Nuxt DevTools launcher.')
              return request.url || baseURL
            }
          },
        }
        return { server: { proxy: { [baseURL]: proxy } } }
      },
    }, { server: false })
    return
  }

  nuxt.hook('vite:serverCreated', async (server, environment) => {
    if (environment && !environment.isClient)
      return
    if (!hasStaticClient) {
      server.middlewares.use(mountedRoute, unavailableClient)
      return
    }
    try {
      server.middlewares.use(mountedRoute, await createExplorerClientMiddleware(clientPath, { baseURL, apiBase: appBase }))
    }
    catch (error) {
      consola.warn('[ODX] Explorer assets are unavailable; the host dev server remains usable.', error)
      server.middlewares.use(mountedRoute, unavailableClient)
    }
  })
}
