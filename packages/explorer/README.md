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

The editor captures the original service, entity set, metadata-owned typed key,
method and session headers when it opens. Single and composite keys use core
OData builders, including differently named keys, numeric zero, escaped strings
and V2/V4 literals. V2 updates use MERGE and V4 updates use PATCH. Missing,
ambiguous or unsafe numeric identities block a write; updates never become
creates. Large Int64/Decimal keys must arrive as exact strings rather than
rounded JavaScript numbers; reads with known V4 metadata request
`IEEE754Compatible=true`. Fractional Decimal keys also require exact strings.
Partial updates may omit keys, but cannot change the captured identity.

The editor sends only structural fields changed from its original snapshot.
Expanded navigation records stay available through View and are excluded from
the row editor. Attempting to add/change a navigation property blocks the
request; edit that related record separately. Saving an unchanged row sends no
write. JSON negotiation, including V4 IEEE754 parameters, is retained on writes.

Session header overrides belong to their selected service and apply to reads,
updates and deletes. Configured server outbound headers are not copied into
the browser's editable override set. Closing an editor does not cancel an
already dispatched write: its outcome remains visible without closing or
overwriting a newer editor. Automatic reloads always use GET, independently of
the raw request selector. Deletion failures report an error instead of claiming
success. Successful writes invalidate the original entity's cache even after
navigation to another entity.

When a row supplies an ETag, updates and deletes carry that captured token in
`If-Match`. Generic session overrides cannot replace it with a wildcard, and
editing JSON annotations cannot change it. Services without row ETags remain
usable; the Explorer does not invent `If-Match: *` or claim optimistic
concurrency for them. HTTP 409/412/428 preserves the draft and explains the
conflict. Use **Discard draft and reload** to explicitly abandon it and fetch
current data before reopening the record. The Explorer does not automatically
retry a conflicted write or silently overwrite the record.

## Advanced requests

The query toolbar executes GET directly. Selecting POST, PUT, PATCH, MERGE or
DELETE changes its action to **Prepare Request**. Review the captured method,
URL/query, session headers and JSON in the editor, then use **Send Request**.
Invalid JSON is rejected before transport. DELETE deliberately sends no body.
The actual HTTP status and response body appear in the same editor after a
successful request; late results do not replace an editor opened afterwards.

These requests use the host proxy route, consistently with row mutations,
even when browser-direct reads have opted out of the CORS bridge. Existing
service strategy, proxy policy and backend authorization still apply. Advanced
requests use the explicit target/query/headers rather than inventing row keys
or ETags: use ordinary Edit/Delete for metadata-owned record operations.

After a dispatched editor write has a network or 5xx failure, its outcome may
be unknown. The editor preserves the draft, invalidates the cached preview and
disables sending that request again. **Close and reload data** lets you inspect
current service state before preparing another write. A known raw-request
409/412/428 instead asks you to review its payload/headers; reloading a row does
not automatically replace explicitly supplied raw headers.

## Host capabilities

The Explorer uses explicit host capabilities for metadata refresh, SDK
generation and the development types endpoint. A Node version alone does not
imply that an SDK generator exists. A host without one still refreshes metadata
and reports `generated: false`.

Services can project `capabilities.dataMethods` from their existing static
method rules. The toolbar omits restricted methods and disables unavailable
Create/Edit/Delete actions; capture and submission also recheck the known
projection. V2 updates use MERGE availability independently of DELETE.
Capabilities help explain the UI; they do not replace proxy/backend policy or
predict dynamic scopes, attributes and hooks. Independent layer hosts without
a method projection retain the previous behavior; malformed explicit lists
fail closed. The direct bridge retains its documented policy boundaries.

For documentation on the DevTools UI and debugging patterns, see the root
documentation in this repository.
