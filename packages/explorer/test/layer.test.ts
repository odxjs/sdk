// @vitest-environment node

import { access, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../nuxt.config'

describe('explorer Nuxt layer', () => {
  it('uses the consumer framework instead of installing a second Nuxt and Vue runtime', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.dependencies.nuxt).toBeUndefined()
    expect(manifest.dependencies.vue).toBeUndefined()
    expect(manifest.peerDependencies).toMatchObject({ nuxt: '^4.6.3', vue: '^3.5.44' })
    expect(manifest.devDependencies).toMatchObject({ nuxt: '4.6.3', vue: '3.5.44' })
  })

  it('resolves its stylesheet from the package instead of the consumer root', async () => {
    const stylesheet = config.css?.[0]

    expect(typeof stylesheet).toBe('string')
    expect(isAbsolute(String(stylesheet))).toBe(true)
    await expect(access(String(stylesheet))).resolves.toBeUndefined()
    expect(config.vite?.server?.fs?.allow).toBeUndefined()
  })
})
