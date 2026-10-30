import { fileURLToPath } from 'node:url'
import { defineVitestProject } from '@nuxt/test-utils/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineVitestProject({
  root: rootDir,
  test: {
    name: 'explorer',
    include: ['test/**/*.test.ts'],
    exclude: ['test/browser.e2e.test.ts'],
    environmentOptions: {
      nuxt: { rootDir },
    },
  },
})
