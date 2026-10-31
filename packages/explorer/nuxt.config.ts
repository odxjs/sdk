import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'

const apiProxyTarget = process.env.ODX_EXPLORER_API_PROXY_TARGET?.replace(/\/$/, '')
const explorerStyles = fileURLToPath(new URL('./app.css', import.meta.url))
const developmentBuildDir = process.env.ODX_EXPLORER_BUILD_DIR

export default defineNuxtConfig({
  ...(developmentBuildDir ? { buildDir: developmentBuildDir } : {}),
  modules: [
    '@nuxt/ui',
  ],
  css: [explorerStyles],
  ssr: false,

  // Nuxt 4 & Monorepo Stability
  future: {
    compatibilityVersion: 4,
  },

  experimental: {
    appManifest: false,
  },

  devtools: { enabled: false },

  vite: {
    ...(developmentBuildDir ? { cacheDir: join(developmentBuildDir, 'vite') } : {}),
    // First Schema intent must not trigger a new dependency discovery/reload
    // that discards the selected service. This only prebundles development
    // dependencies; the optional graph still mounts on user intent.
    optimizeDeps: {
      include: ['@vue-flow/core', '@vue-flow/background', 'elkjs/lib/elk.bundled.js'],
    },
  },

  hooks: {
    'vite:extendConfig': (config, { isClient }) => {
      const optimizeDeps = config.optimizeDeps
      if (!isClient || !optimizeDeps)
        return
      // Nuxt UI marks Reka for SSR transpilation, which Nuxt also copies into
      // client prebundle exclusions. Keep that server contract, but bundle the
      // client's many deep modules rather than opening hundreds of requests.
      optimizeDeps.exclude = optimizeDeps.exclude?.filter(name => name !== 'reka-ui')
      optimizeDeps.include = [...new Set([...(optimizeDeps.include || []), '@nuxt/ui > reka-ui'])]
    },
  },

  runtimeConfig: {
    public: {
      odxApiBase: process.env.NUXT_PUBLIC_ODX_API_BASE || process.env.ODX_API_BASE || '',
    },
  },

  routeRules: apiProxyTarget
    ? {
        '/__odx__/**': {
          proxy: `${apiProxyTarget}/__odx__/**`,
        },
      }
    : {},

  app: {
    baseURL: process.env.ODX_EXPLORER_CLIENT_BASE || '/__odx__/client/',
  },

  devServer: {
    port: 3300,
  },

})
