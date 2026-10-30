import { fileURLToPath } from 'node:url'
import { defineVitestProject } from '@nuxt/test-utils/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineVitestProject({
  root: rootDir,
  test: {
    name: 'explorer',
    include: ['test/**/*.test.ts'],
    environmentOptions: {
      nuxt: { rootDir },
    },
  },
})
