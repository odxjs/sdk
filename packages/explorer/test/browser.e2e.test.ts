import { mkdir } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { getBrowser, setup, url } from '@nuxt/test-utils/e2e'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createExplorerBrowserBackend } from './browser-backend'

describe('explorer real browser usage', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('..', import.meta.url)),
    dev: false,
    browser: true,
    setupTimeout: 180_000,
    browserOptions: {
      type: 'chromium',
      launch: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    },
  })
  let backend: Awaited<ReturnType<typeof createExplorerBrowserBackend>>
  beforeAll(async () => {
    backend = await createExplorerBrowserBackend()
  })
  beforeEach(async () => {
    await backend.reset()
  })
  afterAll(async () => {
    await backend?.close()
  })

  async function openExplorer(activation: 'pointer' | 'keyboard') {
    const context = await (await getBrowser()).newContext({ viewport: { width: 1440, height: 950 }, locale: 'en-US' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push(message.text())
    })
    await page.route('**/*', async (route) => {
      const target = new URL(route.request().url())
      if ((target.pathname.startsWith('/__odx__/') && !target.pathname.startsWith('/__odx__/client/')) || target.pathname.startsWith('/api/odx/')) {
        const response = await route.fetch({ url: `${backend.origin}${target.pathname}${target.search}` })
        await route.fulfill({ response })
      }
      else {
        await route.continue()
      }
    })
    await page.goto(url('/__odx__/client/'), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Services', exact: true }).click()
    const card = page.getByRole('link', { name: 'LocalCatalog', exact: true })
    if (activation === 'keyboard')
      await card.press('Enter')
    else
      await card.locator('[aria-hidden="true"]').click()
    await page.getByText('Products', { exact: true }).filter({ visible: true }).first().click()
    await page.getByRole('button', { name: 'Execute', exact: true }).click()
    await expect.poll(() => page.getByRole('row').filter({ hasText: 'Zero desk' }).isVisible()).toBe(true)
    return { context, page, errors }
  }

  it.each(['pointer', 'keyboard'] as const)('opens a service with %s and keeps data, schema, logs and proxy usable', async (activation) => {
    const { context, page, errors } = await openExplorer(activation)
    try {
      await page.getByRole('tab', { name: 'Schema', exact: true }).click()
      await expect.poll(() => page.locator('.vue-flow__node').count()).toBe(2)
      await expect.poll(() => page.locator('.vue-flow__node').first().evaluate(element =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })), { timeout: 10_000 }).toBe(true)
      await expect.poll(() => page.locator('.vue-flow').evaluate(element => getComputedStyle(element.parentElement!).opacity)).toBe('1')
      if (process.env.ODX_EXPLORER_BROWSER_EVIDENCE === '1') {
        const directory = fileURLToPath(new URL('../../../.artifacts/explorer-baseline-2026-10-30/journeys/', import.meta.url))
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: `${directory}/${activation}-schema.png` })
      }
      await page.getByRole('tab', { name: 'Data', exact: true }).click()
      await expect.poll(() => page.getByRole('row').filter({ hasText: 'Zero desk' }).isVisible()).toBe(true)
      await page.getByRole('button', { name: 'Logs', exact: true }).first().click()
      await expect.poll(() => page.getByRole('row').filter({ hasText: 'Products', visible: true }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
      await page.getByRole('button', { name: 'Proxy', exact: true }).click()
      await expect.poll(() => page.getByRole('heading', { name: 'Proxy Engine', exact: true }).isVisible()).toBe(true)
      expect(backend.requests.some(request => request.method === 'GET' && request.url === '/odata/Products')).toBe(true)
      expect(backend.requests.every(request => request.method === 'GET')).toBe(true)
      expect(errors).toEqual([])
      if (process.env.ODX_EXPLORER_BROWSER_EVIDENCE === '1') {
        const directory = fileURLToPath(new URL('../../../.artifacts/explorer-baseline-2026-10-30/journeys/', import.meta.url))
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: `${directory}/${activation}-proxy.png` })
      }
    }
    finally {
      await context.close()
    }
  })

  it('updates and deletes key zero without creating a record and preserves session headers', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    try {
      await page.getByRole('button', { name: 'Headers', exact: true }).click()
      const editor = page.getByRole('dialog')
      await editor.getByRole('textbox').fill(JSON.stringify({ 'X-Odx-Browser-Session': 'synthetic-session' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      const row = page.getByRole('row').filter({ hasText: 'Zero desk' })
      await row.getByRole('button', { name: 'Edit record', exact: true }).click()
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      const update = backend.requests.find(request => request.method === 'PATCH')
      expect(update).toMatchObject({ url: '/odata/Products(0)', sessionHeader: 'synthetic-session' })
      expect(JSON.parse(update!.body)).toMatchObject({ ID: 0, Name: 'Zero desk' })
      page.once('dialog', async dialog => dialog.accept())
      await row.getByRole('button', { name: 'Delete record', exact: true }).click()
      await expect.poll(() => backend.requests.some(request => request.method === 'DELETE')).toBe(true)
      expect(backend.requests.find(request => request.method === 'DELETE'))
        .toMatchObject({ url: '/odata/Products(0)', sessionHeader: 'synthetic-session' })
      expect(backend.requests.some(request => request.method === 'POST')).toBe(false)
      expect(errors).toEqual([])
    }
    finally {
      await context.close()
    }
  })

  it('keeps an unkeyed record edit open with an error and sends no mutation', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    try {
      await page.getByRole('row').filter({ hasText: 'Unkeyed desk' }).getByRole('button', { name: 'Edit record', exact: true }).click()
      const editor = page.getByRole('dialog')
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.getByText('Cannot update this record without a supported ID. No request was sent.', { exact: true }).isVisible()).toBe(true)
      expect(backend.requests.every(request => request.method === 'GET')).toBe(true)
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      expect(errors).toEqual([])
    }
    finally {
      await context.close()
    }
  })
})
