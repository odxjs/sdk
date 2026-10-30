import process from 'node:process'
import { defineNuxtConfig } from 'nuxt/config'
import ODataModule from '../../../src/module'

const serviceUrl = process.env.ODX_EXPLORER_TEST_SERVICE_URL
if (!serviceUrl)
  throw new Error('This fixture requires the owned synthetic Explorer service.')

export default defineNuxtConfig({
  modules: [ODataModule],
  app: { baseURL: '/console/' },
  devtools: { enabled: true },
  odata: {
    mode: 'sdk',
    basePath: '/custom/odata',
    services: [{ name: 'LocalCatalog', route: 'catalog', strategy: 'proxied', url: serviceUrl }],
  },
  hooks: {
    ready(nuxt) {
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
