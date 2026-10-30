import type { Resolver } from '@nuxt/kit'
import type { Nuxt } from 'nuxt/schema'
import { existsSync } from 'node:fs'
import { startSubprocess } from '@nuxt/devtools-kit'
import { consola } from 'consola'
import { createExplorerClientMiddleware } from './devtools-client'

export const DEVTOOLS_UI_ROUTE = '/__odx__/client'
export const DEVTOOLS_UI_LOCAL_PORT = 3300
const RE_TRAILING_SLASH = /\/$/
const ASSETS_UNAVAILABLE = 'ODX Explorer assets are missing or incompatible. Rebuild the coordinated Explorer and Nuxt packages; installed applications do not start a separate UI server.'

function unavailableClient(_request: unknown, response: { statusCode: number, setHeader: (name: string, value: string) => unknown, end: (body: string) => unknown }): void {
  response.statusCode = 503
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.end(ASSETS_UNAVAILABLE)
}

export function setupDevToolsUI(nuxt: Nuxt, resolver: Resolver): void {
  function resolveExplorerDirectory(resolver: Resolver): string | undefined {
    const workspaceDirectory = resolver.resolve('../../explorer')
    // Only the source checkout may launch a contributor server. Installed
    // packages must use their emitted client, even if the layer is installed.
    if (existsSync(resolver.resolve('./module.ts')) && existsSync(workspaceDirectory))
      return workspaceDirectory
    return undefined
  }

  const clientPath = resolver.resolve('./client')
  const hasStaticClient = existsSync(`${clientPath}/manifest.json`) && existsSync(`${clientPath}/index.html`)
  const appBase = `/${(nuxt.options.app?.baseURL || '/').split('/').filter(Boolean).join('/')}`.replace(RE_TRAILING_SLASH, '')
  const mountedRoute = `${appBase}${DEVTOOLS_UI_ROUTE}`
  let devtoolsUiSrc = `${mountedRoute}/`

  // Serve production-built client (used when package is published)
  if (hasStaticClient) {
    nuxt.hook('vite:serverCreated', async (server, environment) => {
      if (environment && !environment.isClient)
        return
      try {
        server.middlewares.use(
          mountedRoute,
          await createExplorerClientMiddleware(clientPath, { baseURL: `${mountedRoute}/`, apiBase: appBase }),
        )
      }
      catch (error) {
        consola.warn('[ODX] Explorer assets are unavailable; the host dev server remains usable.', error)
        server.middlewares.use(mountedRoute, unavailableClient)
      }
    })
  }
  // In local development, start a separate Nuxt server and proxy to serve the client.
  else {
    const explorerDir = resolveExplorerDirectory(resolver)
    if (explorerDir) {
      let explorerProcess: ReturnType<typeof startSubprocess> | undefined
      const hostAppUrl = `http://localhost:${nuxt.options.devServer?.port || 3000}`
      const explorerUrl = `http://localhost:${DEVTOOLS_UI_LOCAL_PORT}${DEVTOOLS_UI_ROUTE}/`
      devtoolsUiSrc = explorerUrl

      // Start only when Vite is serving. `nuxi prepare` also runs Nuxt modules in
      // dev mode, and starting a long-lived subprocess there keeps prepare alive.
      nuxt.hook('vite:serverCreated', () => {
        explorerProcess ||= startSubprocess(
          {
            command: 'pnpm',
            args: ['exec', 'nuxi', 'dev', '--host', 'localhost', '--port', DEVTOOLS_UI_LOCAL_PORT.toString()],
            cwd: explorerDir,
            env: {
              ODX_EXPLORER_API_PROXY_TARGET: hostAppUrl,
            },
          },
          {
            id: 'odx:client',
            name: 'ODX Explorer Dev',
          },
        )
      })

      nuxt.hook('vite:serverCreated', (server) => {
        server.middlewares.use(DEVTOOLS_UI_ROUTE, (_req, res) => {
          res.statusCode = 302
          res.setHeader('Location', explorerUrl)
          res.end()
        })
      })
    }
    else {
      nuxt.hook('vite:serverCreated', (server) => {
        server.middlewares.use(mountedRoute, unavailableClient)
      })
    }
  }

  (nuxt as any).hook('devtools:customTabs', (tabs: any[]) => {
    tabs.push({
      name: 'odx',
      title: 'ODX',
      icon: 'i-lucide-cable',
      view: {
        type: 'iframe',
        src: devtoolsUiSrc,
      },
    })
  })
}
