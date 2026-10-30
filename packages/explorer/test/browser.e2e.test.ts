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

  async function openExplorer(activation: 'pointer' | 'keyboard' | null, configStatus?: number, contractBackend = backend) {
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
      if (target.pathname === '/__odx__/config' && configStatus) {
        await route.fulfill({ status: configStatus, json: { message: 'Synthetic access denied' } })
        return
      }
      if ((target.pathname.startsWith('/__odx__/') && !target.pathname.startsWith('/__odx__/client/')) || target.pathname.startsWith('/api/odx/')) {
        const response = await route.fetch({ url: `${contractBackend.origin}${target.pathname}${target.search}` })
        await route.fulfill({ response })
      }
      else {
        await route.continue()
      }
    })
    await page.goto(url('/__odx__/client/'), { waitUntil: 'networkidle' })
    if (!activation)
      return { context, page, errors }
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
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('uses host read-only capabilities and still rejects a manual write at the real proxy', async () => {
    const contract = await createExplorerBrowserBackend({ readOnly: true })
    let opened: Awaited<ReturnType<typeof openExplorer>> | undefined
    try {
      opened = await openExplorer('keyboard', undefined, contract)
      const { page, errors } = opened
      const row = page.getByRole('row').filter({ hasText: 'Zero desk' })
      expect(await row.getByRole('button', { name: 'Edit record', exact: true }).isDisabled()).toBe(true)
      expect(await row.getByRole('button', { name: 'Delete record', exact: true }).isDisabled()).toBe(true)
      expect(await page.getByRole('button', { name: 'New Record', exact: true }).isDisabled()).toBe(true)
      await page.getByRole('combobox', { name: 'Request method', exact: true }).click()
      expect(await page.getByRole('option', { name: 'POST', exact: true }).count()).toBe(0)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Service actions', exact: true }).click()
      expect(await page.getByRole('menuitem', { name: 'Regenerate SDK', exact: true }).count()).toBe(0)
      await page.getByRole('menuitem', { name: 'Refresh Metadata', exact: true }).click()
      await expect.poll(() => page.getByText('Metadata Refreshed', { exact: true }).isVisible()).toBe(true)
      const rejected = await page.evaluate(async () => {
        const response = await fetch('/api/odx/catalog/Products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ID: 9, Name: 'Forbidden write' }) })
        return response.status
      })
      expect(rejected).toBe(405)
      expect(contract.requests.some(request => request.method !== 'GET')).toBe(false)
      expect(errors.filter(error => !error.includes('status of 405'))).toEqual([])
    }
    finally {
      await opened?.page.unrouteAll({ behavior: 'wait' })
      await opened?.context.close()
      await contract.close()
    }
  })

  it('reviews a raw request body before dispatch and shows the actual response', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    try {
      await page.getByRole('combobox', { name: 'Request method', exact: true }).click()
      await page.getByRole('option', { name: 'POST', exact: true }).click()
      await page.getByRole('button', { name: 'Prepare Request', exact: true }).click()
      const editor = page.getByRole('dialog')
      await expect.poll(() => editor.getByText('POST /api/odx/catalog/Products', { exact: true }).isVisible()).toBe(true)
      expect(backend.requests.every(request => request.method === 'GET')).toBe(true)
      await editor.locator('textarea').fill('{invalid JSON')
      await editor.getByRole('button', { name: 'Send Request', exact: true }).click()
      await expect.poll(() => editor.getByText(/Invalid JSON:/).isVisible()).toBe(true)
      expect(backend.requests.every(request => request.method === 'GET')).toBe(true)
      await editor.locator('textarea').fill(JSON.stringify({ ID: 9, Name: 'Raw created desk' }))
      await editor.getByRole('button', { name: 'Send Request', exact: true }).click()
      await expect.poll(() => editor.getByRole('heading', { name: 'Response Data', exact: true }).isVisible()).toBe(true)
      expect(JSON.parse(await editor.locator('textarea').inputValue())).toEqual({ ID: 9, Name: 'Raw created desk' })
      await expect.poll(() => page.getByRole('row', { includeHidden: true }).filter({ hasText: 'Raw created desk' }).count()).toBe(1)
      const writes = backend.requests.filter(request => request.method !== 'GET')
      expect(writes).toHaveLength(1)
      expect(writes[0]).toMatchObject({ method: 'POST', url: '/odata/Products', body: JSON.stringify({ ID: 9, Name: 'Raw created desk' }) })
      expect(errors).toEqual([])
    }
    finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('does not re-arm a raw POST when its upstream outcome is uncertain', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    try {
      await page.route('**/api/odx/catalog/Products*', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.fallback()
          return
        }
        await route.fetch({ url: `${backend.origin}/api/odx/catalog/Products` })
        await route.fulfill({ status: 502, json: { message: 'Synthetic lost upstream response' } })
      })
      await page.getByRole('combobox', { name: 'Request method', exact: true }).click()
      await page.getByRole('option', { name: 'POST', exact: true }).click()
      await page.getByRole('button', { name: 'Prepare Request', exact: true }).click()
      const editor = page.getByRole('dialog')
      await editor.locator('textarea').fill(JSON.stringify({ ID: 9, Name: 'Uncertain created desk' }))
      await editor.getByRole('button', { name: 'Send Request', exact: true }).click()
      await expect.poll(() => editor.getByText(/The write outcome is unknown/).isVisible()).toBe(true)
      expect(await editor.getByRole('button', { name: 'Send Request', exact: true }).isDisabled()).toBe(true)
      expect(backend.requests.filter(request => request.method === 'POST')).toHaveLength(1)
      await editor.getByRole('button', { name: 'Close and reload data', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      await expect.poll(() => page.getByRole('row').filter({ hasText: 'Uncertain created desk' }).isVisible()).toBe(true)
      expect(backend.requests.filter(request => request.method === 'POST')).toHaveLength(1)
      expect(errors.filter(error => !error.includes('status of 502'))).toEqual([])
    }
    finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('can cancel a prepared DELETE without dispatching a bodyless mutation', async () => {
    const { context, page, errors } = await openExplorer('keyboard')
    try {
      await page.getByRole('combobox', { name: 'Request method', exact: true }).click()
      await page.getByRole('option', { name: 'DELETE', exact: true }).click()
      await page.getByRole('button', { name: 'Prepare Request', exact: true }).click()
      const editor = page.getByRole('dialog')
      await expect.poll(() => editor.getByText('DELETE sends no request body.', { exact: true }).isVisible()).toBe(true)
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      expect(backend.requests.every(request => request.method === 'GET')).toBe(true)
      expect(errors).toEqual([])
    }
    finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('keeps a newer record editor intact when a dispatched raw POST finishes late', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    let release!: () => void
    const released = new Promise<void>(resolve => release = resolve)
    let captured!: () => void
    const dispatched = new Promise<void>(resolve => captured = resolve)
    try {
      await page.route('**/api/odx/catalog/Products*', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.fallback()
          return
        }
        const response = await route.fetch({ url: `${backend.origin}/api/odx/catalog/Products` })
        captured()
        await released
        await route.fulfill({ response })
      })
      await page.getByRole('combobox', { name: 'Request method', exact: true }).click()
      await page.getByRole('option', { name: 'POST', exact: true }).click()
      await page.getByRole('button', { name: 'Prepare Request', exact: true }).click()
      const editor = page.getByRole('dialog')
      await editor.locator('textarea').fill(JSON.stringify({ ID: 9, Name: 'Late raw created desk' }))
      await editor.getByRole('button', { name: 'Send Request', exact: true }).click()
      await dispatched
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Desk', exact: true }) }).getByRole('button', { name: 'Edit record', exact: true }).click()
      release()
      await expect.poll(() => page.getByText('POST request succeeded (HTTP 201)', { exact: true }).isVisible()).toBe(true)
      expect(JSON.parse(await editor.locator('textarea').inputValue())).toMatchObject({ ID: 1, Name: 'Desk' })
      expect(await editor.getByRole('heading', { name: 'Edit Record', exact: true }).isVisible()).toBe(true)
      expect(backend.requests.filter(request => request.method !== 'GET')).toHaveLength(1)
      expect(errors).toEqual([])
    }
    finally {
      release()
      await page.unrouteAll({ behavior: 'wait' })
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
      await editor.locator('textarea').fill(JSON.stringify({ ID: 0, Name: 'Zero desk updated' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      const update = backend.requests.find(request => request.method === 'PATCH')
      expect(update).toMatchObject({ url: '/odata/Products(0)', sessionHeader: 'synthetic-session' })
      expect(JSON.parse(update!.body)).toEqual({ Name: 'Zero desk updated' })
      page.once('dialog', async dialog => dialog.accept())
      await row.getByRole('button', { name: 'Delete record', exact: true }).click()
      await expect.poll(() => backend.requests.some(request => request.method === 'DELETE')).toBe(true)
      expect(backend.requests.find(request => request.method === 'DELETE'))
        .toMatchObject({ url: '/odata/Products(0)', sessionHeader: 'synthetic-session' })
      expect(backend.requests.some(request => request.method === 'POST')).toBe(false)
      expect(errors).toEqual([])
    }
    finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('keeps session headers on their original service across actual service navigation', async () => {
    const contract = await createExplorerBrowserBackend({ secondService: true })
    let opened: Awaited<ReturnType<typeof openExplorer>> | undefined
    try {
      opened = await openExplorer('pointer', undefined, contract)
      const { page, errors } = opened
      const editor = page.getByRole('dialog')
      await page.getByRole('button', { name: 'Headers', exact: true }).click()
      await editor.getByRole('textbox').fill(JSON.stringify({ 'X-Odx-Browser-Session': 'catalog-only' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      await expect.poll(() => contract.requests.some(request => request.sessionHeader === 'catalog-only')).toBe(true)
      await page.getByRole('button', { name: 'Back to services', exact: true }).click()
      await page.getByRole('link', { name: 'OtherCatalog', exact: true }).press('Enter')
      await page.getByText('Products', { exact: true }).filter({ visible: true }).first().click()
      contract.requests.splice(0)
      await page.getByRole('button', { name: 'Execute', exact: true }).click()
      await expect.poll(() => page.getByRole('row').filter({ hasText: 'Zero desk' }).isVisible()).toBe(true)
      expect(contract.requests.filter(request => request.url === '/odata/Products').map(request => request.sessionHeader)).toEqual([undefined])
      await page.getByRole('button', { name: 'Headers', exact: true }).click()
      expect(JSON.parse(await editor.getByRole('textbox').inputValue())).toEqual({})
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByRole('button', { name: 'Back to services', exact: true }).click()
      await page.getByRole('link', { name: 'LocalCatalog', exact: true }).press('Enter')
      await page.getByText('Products', { exact: true }).filter({ visible: true }).first().click()
      await page.getByRole('button', { name: 'Headers', exact: true }).click()
      expect(JSON.parse(await editor.getByRole('textbox').inputValue())).toEqual({ 'X-Odx-Browser-Session': 'catalog-only' })
      expect(errors).toEqual([])
    }
    finally {
      await opened?.page.unrouteAll({ behavior: 'wait' })
      await opened?.context.close()
      await contract.close()
    }
  })

  it.each(['v2', 'v4'] as const)('edits and deletes an escaped composite identity over real %s transport', async (version) => {
    const contract = await createExplorerBrowserBackend({ version, compositeKey: true })
    let opened: Awaited<ReturnType<typeof openExplorer>> | undefined
    try {
      opened = await openExplorer('keyboard', undefined, contract)
      const { page, errors } = opened
      const row = page.getByRole('row').filter({ hasText: 'Zero desk' })
      await row.getByRole('button', { name: 'Edit record', exact: true }).click()
      const editor = page.getByRole('dialog')
      const method = version === 'v2' ? 'MERGE' : 'PATCH'
      await expect.poll(() => editor.getByText(method, { exact: true }).isVisible()).toBe(true)
      await editor.locator('textarea').fill(JSON.stringify({ Name: 'Zero desk updated' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      const suffix = version === 'v2' ? 'L' : ''
      const paths = [`/odata/Products(Tenant='O''Brien%2F%26%3F',ID=0${suffix})`, `/odata/Products(ID=0${suffix},Tenant='O''Brien%2F%26%3F')`]
      expect(paths).toContain(contract.requests.find(request => request.method === method)?.url)
      page.once('dialog', async dialog => dialog.accept())
      await row.getByRole('button', { name: 'Delete record', exact: true }).click()
      await expect.poll(() => contract.requests.some(request => request.method === 'DELETE')).toBe(true)
      expect(paths).toContain(contract.requests.find(request => request.method === 'DELETE')?.url)
      expect(contract.requests.some(request => request.method === 'POST')).toBe(false)
      expect(errors).toEqual([])
    }
    finally {
      await opened?.page.unrouteAll({ behavior: 'wait' })
      await opened?.context.close()
      await contract.close()
    }
  })

  it.each([200, 409])('keeps a later record editor open when an earlier dispatched write finishes with HTTP %i', async (status) => {
    const { context, page, errors } = await openExplorer('pointer')
    let release!: () => void
    const released = new Promise<void>(resolve => release = resolve)
    let captured!: () => void
    const dispatched = new Promise<void>(resolve => captured = resolve)
    try {
      await page.getByRole('combobox', { name: 'Request method', exact: true }).click()
      await page.getByRole('option', { name: 'DELETE', exact: true }).click()
      await page.route('**/api/odx/catalog/Products*', async (route) => {
        if (route.request().method() !== 'PATCH') {
          await route.fallback()
          return
        }
        const response = status === 200 ? await route.fetch({ url: `${backend.origin}/api/odx/catalog/Products(0)` }) : null
        captured()
        await released
        if (response)
          await route.fulfill({ response })
        else
          await route.fulfill({ status, json: { message: 'Synthetic late conflict' } })
      })
      await page.getByRole('row').filter({ hasText: 'Zero desk' }).getByRole('button', { name: 'Edit record', exact: true }).click()
      const editor = page.getByRole('dialog')
      await editor.locator('textarea').fill(JSON.stringify({ Name: 'Zero desk pending' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await dispatched
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      const nextRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Desk', exact: true }) })
      await nextRow.getByRole('button', { name: 'Edit record', exact: true }).click()
      release()
      await expect.poll(() => page.getByText(status === 200 ? 'Item updated successfully' : 'Request conflict (HTTP 409). Reload data before retrying. Synthetic late conflict', { exact: true }).isVisible()).toBe(true)
      await expect.poll(() => editor.isVisible()).toBe(true)
      expect(JSON.parse(await editor.locator('textarea').inputValue())).toMatchObject({ ID: 1, Name: 'Desk' })
      if (status === 200) {
        expect(backend.requests.find(request => request.method === 'PATCH')).toMatchObject({ url: '/odata/Products(0)' })
        expect(backend.requests.filter(request => request.method !== 'GET').map(request => request.method)).toEqual(['PATCH'])
      }
      else {
        expect(backend.requests.every(request => request.method === 'GET')).toBe(true)
      }
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(errors.filter(error => !error.includes('status of 409'))).toEqual([])
    }
    finally {
      release()
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('does not dispatch an unchanged row as a write', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    try {
      await page.getByRole('row').filter({ hasText: 'Zero desk' }).getByRole('button', { name: 'Edit record', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
      await expect.poll(() => page.getByText('No changes to save', { exact: true }).isVisible()).toBe(true)
      expect(backend.requests.every(request => request.method === 'GET')).toBe(true)
      expect(errors).toEqual([])
    }
    finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('invalidates the original preview cache when a dispatched write finishes after entity navigation', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    let release!: () => void
    const released = new Promise<void>(resolve => release = resolve)
    let captured!: () => void
    const dispatched = new Promise<void>(resolve => captured = resolve)
    try {
      await page.route('**/api/odx/catalog/Products*', async (route) => {
        if (route.request().method() !== 'PATCH') {
          await route.fallback()
          return
        }
        const response = await route.fetch({ url: `${backend.origin}/api/odx/catalog/Products(0)` })
        captured()
        await released
        await route.fulfill({ response })
      })
      await page.getByRole('row').filter({ hasText: 'Zero desk' }).getByRole('button', { name: 'Edit record', exact: true }).click()
      const editor = page.getByRole('dialog')
      await editor.locator('textarea').fill(JSON.stringify({ Name: 'Changed while away' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await dispatched
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByText('Suppliers', { exact: true }).filter({ visible: true }).first().click()
      await page.getByRole('button', { name: 'Execute', exact: true }).click()
      await expect.poll(() => page.getByRole('row').filter({ hasText: 'Browser supplier' }).isVisible()).toBe(true)
      release()
      await expect.poll(() => page.getByText('Item updated successfully', { exact: true }).isVisible()).toBe(true)
      await page.getByText('Products', { exact: true }).filter({ visible: true }).first().click()
      await expect.poll(() => page.getByText('No data loaded yet', { exact: true }).isVisible()).toBe(true)
      expect(await page.getByRole('row').filter({ hasText: 'Zero desk' }).count()).toBe(0)
      await page.getByRole('button', { name: 'Execute', exact: true }).click()
      await expect.poll(() => page.getByRole('row').filter({ hasText: 'Changed while away' }).isVisible()).toBe(true)
      expect(errors).toEqual([])
    }
    finally {
      release()
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it.each(['v2', 'v4'] as const)('preserves a conflicted draft and reloads fresh %s ETags before updating and deleting', async (version) => {
    const contract = await createExplorerBrowserBackend({ version, concurrency: true, expanded: version === 'v4' })
    let opened: Awaited<ReturnType<typeof openExplorer>> | undefined
    try {
      opened = await openExplorer('keyboard', undefined, contract)
      const { page, errors } = opened
      const editor = page.getByRole('dialog')
      if (version === 'v4') {
        await page.getByPlaceholder('?id=... or ?$filter=...').fill('?$expand=Supplier')
        await page.getByRole('button', { name: 'Execute', exact: true }).click()
        await expect.poll(() => contract.requests.some(request => request.url === '/odata/Products?$expand=Supplier')).toBe(true)
      }
      await page.getByRole('button', { name: 'Headers', exact: true }).click()
      await editor.getByRole('textbox').fill(JSON.stringify({ 'IF-MATCH': '*' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      await page.getByRole('row').filter({ hasText: 'Zero desk' }).getByRole('button', { name: 'Edit record', exact: true }).click()
      expect(JSON.parse(await editor.locator('textarea').inputValue())).not.toHaveProperty('Supplier')
      const draft = { Name: 'My preserved draft' }
      if (version === 'v4') {
        await editor.locator('textarea').fill(JSON.stringify({ Supplier: { ID: 'S1', Name: 'Wrong deep update' } }))
        await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
        await expect.poll(() => editor.getByText('Edit navigation records separately. No request was sent.', { exact: true }).isVisible()).toBe(true)
        expect(contract.requests.every(request => request.method === 'GET')).toBe(true)
      }
      await editor.locator('textarea').fill(JSON.stringify(draft))
      contract.advanceRecord()
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.getByText(/Request conflict \(HTTP 412\).*The record changed on the service/).isVisible()).toBe(true)
      expect(JSON.parse(await editor.locator('textarea').inputValue())).toEqual(draft)
      const method = version === 'v2' ? 'MERGE' : 'PATCH'
      expect(contract.requests.filter(request => request.method === method).map(request => request.ifMatch)).toEqual(['W/"1"'])
      expect(await page.getByRole('row', { includeHidden: true }).filter({ hasText: 'My preserved draft' }).count()).toBe(0)
      if (process.env.ODX_EXPLORER_BROWSER_EVIDENCE === '1') {
        const directory = fileURLToPath(new URL('../../../.artifacts/explorer-baseline-2026-10-30/journeys/', import.meta.url))
        await mkdir(directory, { recursive: true })
        await editor.evaluate(async (element) => {
          await Promise.all(element.getAnimations({ subtree: true })
            .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
            .map(animation => animation.finished.catch(() => {})))
        })
        await page.screenshot({ path: `${directory}/${version}-conflict.png` })
      }
      await editor.getByRole('button', { name: 'Discard draft and reload', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      const refreshed = page.getByRole('row').filter({ hasText: 'Server desk' })
      await expect.poll(() => refreshed.isVisible()).toBe(true)
      await refreshed.getByRole('button', { name: 'Edit record', exact: true }).click()
      await editor.locator('textarea').fill(JSON.stringify({ 'Name': 'Fresh successful update', '@odata.etag': '*' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      const updated = page.getByRole('row').filter({ hasText: 'Fresh successful update' })
      await expect.poll(() => updated.isVisible()).toBe(true)
      const writes = contract.requests.filter(request => request.method === method)
      expect(writes.map(request => request.ifMatch)).toEqual(['W/"1"', 'W/"2"'])
      expect(JSON.parse(writes[1]!.body)).toEqual({ Name: 'Fresh successful update' })
      page.once('dialog', async dialog => dialog.accept())
      await updated.getByRole('button', { name: 'Delete record', exact: true }).click()
      await expect.poll(() => updated.count()).toBe(0)
      expect(contract.requests.find(request => request.method === 'DELETE')?.ifMatch).toBe('W/"3"')
      expect(errors.filter(error => !error.includes('status of 412'))).toEqual([])
    }
    finally {
      await opened?.page.unrouteAll({ behavior: 'wait' })
      await opened?.context.close()
      await contract.close()
    }
  })

  it('rejects changed keys before transport and permits a partial update without keys', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    try {
      await page.getByRole('row').filter({ hasText: 'Zero desk' }).getByRole('button', { name: 'Edit record', exact: true }).click()
      const editor = page.getByRole('dialog')
      await editor.locator('textarea').fill(JSON.stringify({ ID: 5, Name: 'Wrong identity' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.getByText('Key changes are not supported. No request was sent.', { exact: true }).isVisible()).toBe(true)
      expect(backend.requests.every(request => request.method === 'GET')).toBe(true)
      await editor.locator('textarea').fill(JSON.stringify({ Name: 'Renamed desk' }))
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      expect(backend.requests.find(request => request.method === 'PATCH')).toMatchObject({ url: '/odata/Products(0)', body: JSON.stringify({ Name: 'Renamed desk' }) })
      await expect.poll(() => page.getByRole('row').filter({ hasText: 'Renamed desk' }).isVisible()).toBe(true)
      expect(errors).toEqual([])
    }
    finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('keeps an unkeyed record edit open with an error and sends no mutation', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    try {
      await page.getByRole('row').filter({ hasText: 'Unkeyed desk' }).getByRole('button', { name: 'Edit record', exact: true }).click()
      const editor = page.getByRole('dialog')
      await editor.getByRole('button', { name: 'Save Changes', exact: true }).click()
      await expect.poll(() => editor.getByText('Record key ID is missing or invalid. No request was sent.', { exact: true }).isVisible()).toBe(true)
      expect(backend.requests.every(request => request.method === 'GET')).toBe(true)
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(() => editor.count()).toBe(0)
      expect(errors).toEqual([])
    }
    finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('keeps the chosen entity after a previous Execute response arrives late', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    let release!: () => void
    const released = new Promise<void>(resolve => release = resolve)
    let captured!: () => void
    const requestCaptured = new Promise<void>(resolve => captured = resolve)
    let finished!: () => void
    const requestFinished = new Promise<void>(resolve => finished = resolve)
    try {
      await page.route('**/api/odx/catalog/Products*', async (route) => {
        try {
          const response = await route.fetch({ url: `${backend.origin}/api/odx/catalog/Products` })
          captured()
          await released
          // The original browser fetch is expected to be aborted on selection change.
          await route.fulfill({ response }).catch(() => {})
        }
        finally {
          finished()
        }
      })
      await page.getByRole('button', { name: 'Execute', exact: true }).click()
      await requestCaptured
      await page.getByText('Suppliers', { exact: true }).filter({ visible: true }).first().click()
      await page.getByRole('button', { name: 'Execute', exact: true }).click()
      const supplier = page.getByRole('row').filter({ hasText: 'Browser supplier' })
      await expect.poll(() => supplier.isVisible()).toBe(true)
      release()
      await requestFinished
      await expect.poll(() => supplier.isVisible()).toBe(true)
      expect(await page.getByRole('row').filter({ hasText: 'Zero desk' }).count()).toBe(0)
      expect(errors).toEqual([])
    }
    finally {
      release()
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it.each([401, 403])('shows configuration HTTP %i as unavailable and recovers through Retry', async (status) => {
    const { context, page, errors } = await openExplorer(null, status)
    try {
      await expect.poll(() => page.getByText('Configuration unavailable', { exact: true }).isVisible()).toBe(true)
      expect(await page.getByText(`Explorer configuration unavailable (HTTP ${status}).`, { exact: true }).isVisible()).toBe(true)
      await page.route('**/__odx__/config', async (route) => {
        const response = await route.fetch({ url: `${backend.origin}/__odx__/config` })
        await route.fulfill({ response })
      })
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect.poll(() => page.getByText('Configuration unavailable', { exact: true }).count()).toBe(0)
      await page.getByRole('button', { name: 'Services', exact: true }).click()
      await expect.poll(() => page.getByRole('link', { name: 'LocalCatalog', exact: true }).count()).toBe(1)
      // Chromium reports failed HTTP resources to its console; the UI handles them.
      expect(errors.filter(error => !error.includes(`status of ${status}`))).toEqual([])
    }
    finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('shows denied traffic as an error, then restores actual logs through Retry', async () => {
    const { context, page, errors } = await openExplorer('pointer')
    let denied = true
    try {
      await page.route('**/__odx__/logs', async (route) => {
        if (denied) {
          await route.fulfill({ status: 403, json: { message: 'Synthetic access denied' } })
          return
        }
        const response = await route.fetch({ url: `${backend.origin}/__odx__/logs` })
        await route.fulfill({ response })
      })
      await page.getByRole('button', { name: 'Logs', exact: true }).first().click()
      await expect.poll(() => page.getByText('Traffic logs unavailable (HTTP 403).', { exact: true }).isVisible(), { timeout: 10_000 }).toBe(true)
      denied = false
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect.poll(() => page.getByText('Traffic logs unavailable', { exact: true }).count()).toBe(0)
      await expect.poll(() => page.getByRole('row').filter({ hasText: 'Products', visible: true }).count()).toBeGreaterThan(0)
      expect(errors.filter(error => !error.includes('status of 403'))).toEqual([])
    }
    finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })
})
