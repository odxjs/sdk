# @me-tools/odx-explorer

A high-fidelity DevTools UI built with Nuxt UI for inspecting OData schemas, traffic, and entity data.

## Installation

```bash
pnpm add @me-tools/odx-explorer
```

## Verification

The initial unpublished Explorer release targets Nuxt 4.6.3+, Vue 3.5.44+ and
Node 22.22.3+ or 24.15+ within the supported Node 22/24 lines. Its repository
toolchain pins pnpm 11.28.9. Older layer-host combinations are not claimed by
this upgrade; the portable OData packages retain their independent contracts.

Explorer is a Nuxt layer: its consumer supplies compatible Nuxt 4 and Vue 3
peer dependencies (`nuxt >=4.6.3 <5`, `vue >=3.5.44 <4`). It does not install a
second framework runtime below the layer. Standalone repository builds retain
their pinned development versions; an application extending the published
layer uses its own framework installation.

Run the Explorer package tests without the full workspace test suite:

```bash
pnpm --filter @me-tools/odx-explorer run verify
```

The same state and layer tests also run from the workspace root:

```bash
pnpm exec vitest run packages/explorer/test
```

The repository build emits both the existing standalone Node application and
a static client under `dist/client`. The exported `./client-manifest` records
the package version, source and lockfile fingerprints, build identity and exact
file hashes. Its icons are bundled locally; the installed Nuxt-module client
does not require an icon API. The Nuxt package copies this client at build time
while the Explorer's default export remains the independently usable Nuxt layer.

The Explorer declares a Nuxt Vitest workspace project with a package-relative
root. Its state tests use that project's existing Nuxt app context instead of
creating a competing application. Browser journeys are verified separately.

```bash
pnpm --filter @me-tools/odx-nuxt exec playwright-core install chromium
pnpm --filter @me-tools/odx-explorer test:browser
```

The browser check builds its own Explorer, owns its temporary preview and uses
real ODX handlers against a synthetic loopback OData service. It never requires
SAP credentials. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing
compatible Chromium installation; otherwise Playwright uses its installed
default. Set `ODX_EXPLORER_BROWSER_EVIDENCE=1` to keep local journey screenshots.

Explorer state and its effects belong to one Nuxt application. Multiple views
share one controller; separate applications do not share session headers,
selection or data caches. Entity/service changes abort obsolete reads, and late
responses cannot overwrite the current preview or schema. App teardown stops
the owned effects and pending reads.
The graph controller follows its rendered component's lifetime so remounts
rebind Vue Flow instead of retaining a detached store. Dispatched non-GET
requests retain their response and original request context after navigation;
aborting a browser fetch would not undo an upstream write.

Traffic polling coalesces slow reads, pauses while the document is hidden and
reconciles when it becomes visible. Unmount removes the timer and visibility
listener. Configuration and traffic access failures show an explicit error and
Retry action; denied responses clear previously displayed private state. Failed
history deletion retains the existing history and reports the failure.

In a same-origin embedded host, polling also observes the owning iframe and
its ancestors. A retained pane with disabled pointer interaction, `inert`, or
hidden CSS pauses reads even when its document still reports `visible`.
Returning to the pane reconciles immediately; active size/style changes do
not dispatch extra reads. Teardown disconnects the observer. Cross-origin
frames retain browser isolation and only use document visibility.

## Record editing

The editor's selected operation determines whether it creates or updates a
record. An update without a supported single ID reports an error and sends no
request; it cannot fall back to creating a record. Numeric ID `0` is supported,
IDs are URL-encoded, and session headers apply to updates and deletion as well
as reads. Failed deletion reports an error instead of claiming success.
This path still uses the proxy's existing single-ID compatibility rewrite;
metadata-derived composite keys and entity ETags are separate migration work.

For documentation on the DevTools UI and debugging patterns, see the root
documentation in this repository.
