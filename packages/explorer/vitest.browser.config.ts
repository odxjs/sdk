import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'explorer-browser',
    environment: 'node',
    include: ['test/browser.e2e.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
})
