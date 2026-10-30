import type { HighlighterCore } from 'shiki/core'
import { createHighlighter } from 'shiki'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createExplorerJSONHighlighter } from '../utils/jsonHighlighter'

describe('explorer JSON-only syntax rendering', () => {
  let original: HighlighterCore | undefined
  let focused: HighlighterCore | undefined
  beforeAll(async () => {
    original = await createHighlighter({ langs: ['json'], themes: ['github-light', 'github-dark'] })
    focused = await createExplorerJSONHighlighter()
  })
  afterAll(() => {
    original?.dispose()
    focused?.dispose()
  })

  it.each(['github-light', 'github-dark'])('retains the original %s token HTML, including invalid JSON and hostile text', (theme) => {
    for (const code of [
      '{"ID":0,"Name":"Desk","Active":true,"Price":-1.25e3,"Deleted":null}',
      '{"unicode":"ö🙂","escape":"\\u0041\\n\\\"","items":[1,false,{}]}',
      '{"payload":"</script><img src=x onerror=alert(1)>"}',
      '{"nested":{"values":[1,2,3]},"Number":"9007199254740993"}',
      '{invalid JSON',
      '',
    ]) {
      const result = focused!.codeToHtml(code, { lang: 'json', theme })
      expect(result).toBe(original!.codeToHtml(code, { lang: 'json', theme }))
      expect(result).not.toContain('<img src=')
    }
    expect(focused!.getLoadedLanguages()).toEqual(['json'])
  })
})
