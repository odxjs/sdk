import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { defineNuxtConfig } from 'nuxt/config'
import ODataModule from '../../../src/module'

const RE_ORIGIN = /http:\/\/127\.0\.0\.1:\d+/
const RE_TRAILING_SLASH = /\/$/

const serviceUrl = process.env.ODX_EXPLORER_TEST_SERVICE_URL
if (!serviceUrl)
  throw new Error('This fixture requires the owned synthetic Explorer service.')

export default defineNuxtConfig({
  modules: [ODataModule],
  app: { baseURL: process.env.ODX_EXPLORER_TEST_APP_BASE || '/console/' },
  devtools: { enabled: true },
  odata: {
    mode: 'sdk',
    basePath: '/custom/odata',
    services: [{ name: 'LocalCatalog', route: 'catalog', strategy: 'proxied', url: serviceUrl }],
  },
  hooks: {
    ready(nuxt) {
      nuxt.hook('devtools:ready', (context) => {
        const startChildProcess = context.terminals.startChildProcess.bind(context.terminals)
        let launchAttempts = 0
        context.terminals.startChildProcess = (options, terminal) => {
          if (terminal?.id === 'odx:client') {
            launchAttempts++
            if (process.env.ODX_EXPLORER_TEST_FAIL_FIRST === '1' && launchAttempts === 1)
              return startChildProcess({ ...options, args: ['-e', 'console.error("Synthetic Explorer startup failure");process.exit(7)'] }, terminal)
          }
          return startChildProcess(options, terminal)
        }
        async function reportOwnedClients(message: unknown): Promise<void> {
          if (message !== 'odx-explorer-test:diagnostics')
            return
          const sessions = Array.from(context.terminals.sessions.values(), (session) => {
            const output = 'buffer' in session && Array.isArray(session.buffer) ? stripVTControlCharacters(session.buffer.join('')) : ''
            return { id: session.id, status: session.status, outputBytes: output.length, ready: output.includes('Ready in'), origin: output.match(RE_ORIGIN)?.[0] }
          })
          const probes = await Promise.all(sessions.map(async (session) => {
            if (!session.ready || !session.origin)
              return undefined
            try {
              const base = `${(process.env.ODX_EXPLORER_TEST_APP_BASE || '/console/').replace(RE_TRAILING_SLASH, '')}/_nuxt/odx-explorer/`
              const response = await fetch(`${session.origin}${base}`, { signal: AbortSignal.timeout(2000) })
              const html = await response.text()
              return { status: response.status, bytes: html.length, nuxtConfig: html.includes('window.__NUXT__.config='), loading: html.includes('nuxt-loading'), contentType: response.headers.get('content-type') }
            }
            catch { return { unavailable: true } }
          }))
          process.send?.({ type: 'odx-explorer-test:diagnostics', sessions, probes, launchAttempts })
        }
        process.on('message', reportOwnedClients)
        nuxt.hook('close', () => {
          process.off('message', reportOwnedClients)
        })
      })
      async function closeOwnedHost(message: unknown): Promise<void> {
        if (message !== 'odx-explorer-test:close')
          return
        await nuxt.close()
        process.exit(0)
      }
      process.on('message', closeOwnedHost)
      nuxt.hook('close', () => {
        process.off('message', closeOwnedHost)
      })
    },
  },
})
