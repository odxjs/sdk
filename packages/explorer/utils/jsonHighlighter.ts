import type { HighlighterCore } from 'shiki/core'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import json from 'shiki/langs/json.mjs'
import githubDark from 'shiki/themes/github-dark.mjs'
import githubLight from 'shiki/themes/github-light.mjs'

/** The Explorer edits JSON, so unrelated language/theme chunks have no owner. */
export function createExplorerJSONHighlighter(): Promise<HighlighterCore> {
  return createHighlighterCore({
    langs: [json],
    themes: [githubLight, githubDark],
    engine: createJavaScriptRegexEngine(),
  })
}
