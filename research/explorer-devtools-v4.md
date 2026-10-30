# ODX Explorer: current audit and DevTools v4 migration plan

Recorded 2026-10-30. Baseline: ODX `main` at `9f8940a`.
The audit below records that original revision. Implementation is now in
progress; the v4 migration and release acceptance are not complete. The audit
and subsequent implementation reviews use Claude Opus 5.5 with selected
synthetic project source.

## Implementation progress

### D1: metadata-owned record mutations

The editor now captures the original service, entity, typed key, method and
service-specific session headers. Core builders own literal formatting and
escaping; updates use V2 MERGE or V4 PATCH. A displayed row must belong to the
current preview and metadata before it can be edited or deleted. Missing keys,
changed key values and already rounded large numeric keys fail closed. Partial
updates may omit unchanged keys. A late write result cannot replace a later
editor, and failures remain visible after the first editor was closed.

Opus identified that post-write refresh previously reused the raw method
selector: a refresh could therefore dispatch a second, bodyless mutation.
Automatic editor reload now has its own GET entrypoint. Session overrides are
kept per service, with the header editor retaining its original service owner;
server-configured outbound headers are no longer copied into that editor.

The real V2/V4 composite browser contract also exposed a proxy bug below the
Explorer: H3 decodes `%26` and `%3F` in `event.path` before route dispatch. Parsing
that path broke opaque keys at their apparent query boundary. Commit `2427b9f`
uses the original mount-relative Node request URL while retaining the existing
resource-path validator. The real HTTP probe now reaches and updates the
synthetic backend. All 200 focused URL/proxy/target/policy cases pass, including
dispatch through a parent H3 mount. The Explorer state/identity suite passes
71 cases. All 14 freshly built production Chromium journeys passed, including
V2/V4 composite edit/delete, actual header isolation across service navigation,
key-change rejection and partial updates, and late success/conflict while a
newer editor stays intact. The subsequent fractional-Decimal guard and V4
IEEE754 Accept negotiation are covered by the final focused unit run; the
browser fixture itself exercises integer/string keys. Explorer typecheck and
changed-file lint passed. Entity ETags and conflict-specific recovery follow
as D2.

### Earlier baseline and native integration

The executable baseline/controller work is implemented in local commits
`e59c959`, `f0f5f77`, `586080b`, `cb0bebd`, `e63b9dd` and `e6dc130`:

- The root Vitest workspace now uses a package-root Nuxt test project. The
  original missing-import collection failure is fixed without reinstalling or
  changing framework versions.
- Service opening reproduced a Vue Flow store feedback loop. Removing the
  store-to-`v-model` feedback restores normal pointer and keyboard use.
- ID zero remains an update/delete identity. Missing update identity fails
  closed; deletion failures and session headers are handled explicitly.
- Shared controllers/effects belong to one app. Read cancellation also rejects
  late transport/body results; cache keys and query inputs are captured before
  dispatch. Graph ownership follows its rendered component and survives a
  remount; a dispatched non-GET outcome remains available after navigation.
- Log polling coalesces slow reads, pauses while hidden and stops on unmount.
  Old polls cannot restore cleared history. Config/log 401/403 responses show
  visible errors and Retry, and clear previously displayed private state.

Executed evidence: 54 focused state/layer/lifecycle tests passed on the
controller slice, and eight freshly built production-browser cases passed with
exit code zero in 44.45 seconds. The browser cases cover actual service/card
activation, entity read, painted schema, traffic/proxy inspection, zero-ID
writes, missing-key rejection, delayed selection and denied-state recovery.
The graph remount regression uses an actual mounted Vue/Nuxt component. These
are local synthetic contracts, not authenticated SAP/BTP acceptance.

The raw before evidence remains in
`.artifacts/explorer-baseline-dev-2026-10-30/browser.json`; current receipts are
under `.artifacts/explorer-baseline-2026-10-30/`, including
`browser-controller-cleanup.{json,log}` and the Opus review receipts.

Slice B's outside-workspace packed consumer now passes. A prerendered client,
including 103 source/default UI icons, is emitted without removing the
standalone Node output and copied into the Nuxt package. Its manifest verifies
the coordinated package version, source/lockfile fingerprints, exact files and
byte identity. Installed serving uses one host origin, preserves `/console/`
for both operational and proxy calls, and starts no contributor UI server.
Missing/incompatible assets return 503 while the host stays usable. The
static allowlist rejects raw traversal and missing assets instead of returning
an HTML shell for script requests.

The real installed host revealed and fixed an existing Nitro integration gap:
early request hooks must normalize `runtimeConfig.app.baseURL` before matching
proxy/auth routes. This is isolated in commit `964eddf`; 96 focused proxy and
policy cases pass. Existing endpoint-level production policy remains in force.

The final consumer run took 130.75 seconds, including fresh serial builds of
metadata/core/proxy/Nuxt, four tarballs, clean installation, real Chromium
navigation/read/reload, a production build and actual production HTTP checks.
It verifies the installed module's dependency graph (no Explorer/UI/graph
runtime packages), the shipped client hashes, the developer route's 404, normal
public synthetic OData reads, and rejection of unauthenticated operational
metadata, including ambiguous base-prefix paths. It supplies the workspace's
TypeScript 5.9.3 explicitly as the host compiler; a compiler-less fixture had
allowed the generator's broad peer range to choose an incompatible compiler.
The resolved SDK generator was 0.40.2. This is a pinned-baseline delivery proof,
not acceptance of future compiler majors.

Current receipts: `state-static-reviewed.json` (63/63),
`nested-proxy-context.json` (96/96), and
`installed-consumer-compiler-baseline/receipt.json` under the baseline evidence
directory. The latter records commands, timings and source/output fingerprints;
the resolved versions are beside it in `dependency-versions.json`.
Those B receipts predate the coherent stack upgrade in slice C below.

### C implementation decisions

C1 is committed as `d07037c`. C2 replaces the legacy custom-tab/process calls
with native DevTools 4 dock, command and terminal contracts. The initial
unpublished Nuxt module now declares Nuxt `>=4.6.3 <5` compatibility, matching
the upgraded layer/toolchain; a v3 custom-tab shim is deliberately not retained.
Framework-neutral transport packages keep their independent runtime floors.

Installed modules register the shipped static iframe and start no child.
Only a repository launcher command can start a source client; a GET/WS cannot.
Ports come from the actual Nuxt listener announcement, and native termination,
context replacement and Nuxt close own cleanup. Source HTTP/HMR mount under
the host's Vite asset namespace, while OData/config/log calls keep the host's
API base and policy. Parent credentials are stripped only on frontend proxy
forwarding. Default DevTools authorization remains enabled.

Actual native Chromium use exposed issues absent from the mocked adapter tests:
Kit's `build: false` option skipped the plugin even in development; the RPC
sidecar initially used a different loopback family; an `onLaunch` function was
dropped by shared-state serialization; and an out-of-asset WS upgrade also
reached Nitro. The adapter now uses serve-only plugins, late public listener
host discovery, a registered authenticated command, and one client-environment
proxy under the Vite asset mount. Public HMR listener options connect its WS
upgrade owner; no private Nuxt listener field or manual global listener removal
is used. The source probe completes data/schema/log/proxy navigation and both
host/client HMR handshakes with zero browser errors. The permanent native
browser gate additionally exercises terminal termination and relaunch.

The permanent native gate passes in 64.24 s, including the normal local OTP
flow, two real Nuxt client starts and graceful host disposal. Its receipt is
`c2-native-final/receipt.json` under the baseline evidence directory: no page or
console errors, no failed browser responses, and actual host/client HMR
connections. Twenty-one focused adapter/native-terminal cases and root
TypeScript checking pass. The final combined affected regressions pass 82/82.

The updated outside-workspace packed consumer passes in 86.98 s, including
serial package builds, four tarballs, installation, Chromium service/read/deep
reload and actual production HTTP checks. Ordinary production output contains
no Explorer client assets/routes; public synthetic OData remains usable and
unauthenticated operational metadata remains denied. Resolved versions are
Nuxt 4.6.3, Vue 3.5.44, DevTools 4.0.0 and the explicit TypeScript 5.9.3 compiler
baseline. The fixture pins Nitro to the module's checked baseline and permits
Devframe H3 v2 while pinning v1 consumers independently.

This check required three harness corrections for the final stack: pnpm 11
reads `PNPM_CONFIG_*` environment settings and YAML project overrides, not the
old npm environment/package.json fields; tsx can resolve a missing consumer
dependency back to the harness workspace, so an unhooked Node process now
proves resolution isolation alongside the actual installed graph; and the
browser waits for Nuxt's ready announcement instead of treating its initial
503 startup document as the Explorer. Packing skips only repeated lifecycle
checks after the explicit serial builds, not the consumer assertions. Its
receipt is `installed-consumer-c2/receipt.json`; path provenance and resolved
versions are beside it. The initial B evidence remains separate.

The viewer retains visited iframe panes and initializes their document URL
once. A restart therefore registers a fresh public `frameId` and instance URL,
while retaining the stable ODX dock id. The native browser gate confirms a new
document navigation and that the old pane no longer accepts pointer events.
This also exposes the next embedded-UX slice: a hidden pane's document stays
`visible`, so document visibility alone cannot pause its background polling.

That bounded E1 slice is now implemented and measured with actual native pane
switching: in matched 6.5-second hidden windows, log reads drop from 2 to 0;
return reconciliation improves from 2,335 ms to 59 ms in these local samples.
Both documents still report `visible`. The new controller observes only its
same-origin frame/ancestor attributes and uses standard interaction/visibility
state, not a Devframe opacity constant. Active resizing does not trigger extra
reads; unmount disconnects the observer. Three focused ownership tests and the
native data/schema/log/proxy/HMR/terminate/relaunch journey pass. The before
receipt explicitly records measurements without asserting the new visibility
gate; the after run asserts zero hidden reads. Receipts are
`e1-polling-{before,after}/receipt.json`. These timings are local observations,
not a general startup/performance promise.

The next bounded change updates the primary Nuxt host to 4.6.3, Kit/Schema to
the same version, Test Utils to 4.3.4 and Module Builder to 1.0.3. The initial
separate Nuxt update exposed a real bootstrap failure: Nuxt UI 4.9 calls
`injectHead().hooks.hookOnce`, removed by Nuxt 4.6's Unhead 3. A regression test
now checks the Nuxt app initialization error explicitly. Upgrade Nuxt UI to
4.12 in the same coherent stack change, including the Docus consumer (whose
declared UI range already permits 4.12).
The registry confirms that Nuxt 4.6.3 requires Vue `^3.5.44` and Node
`^22.22.3 || ^24.15.0 || >=26.0.0`; the workspace will retain its supported
22/24 lines with those updated patch floors and synchronize Vue/compiler-SFC
at 3.5.44. Node 26 is outside this migration. Remote Node guidance must move
from 24.11 to 24.15. Framework-neutral packages retain their independent
runtime contracts.

The workspace now pins pnpm 11.28.9. The new peer graph reproducibly stalled
under pnpm 10.33; the pnpm 11 resolution seeded from the clean B lockfile
completed in 28.2 seconds and its frozen install in 355 ms. Full fresh
resolution was deliberately discarded to retain unrelated locked versions.
Both intermediate task-generated lockfiles are preserved with the local
evidence. No supply-chain policy was disabled and no release-age exclusions
were added. The scoped H3 override pins v1 consumers to 1.15.11 while allowing
Devframe's H3 v2 dependency. Hub/Devframe's exact agentic peer is aligned at
1.2.6. Explicit root/docs parser providers satisfy their modern host scope;
Content-scoped older parser peers remain an upstream limitation. The proposed
unctx dependency extension did not resolve those peers and was removed after
Opus review.

Observed remaining peer warnings concern Content-scoped unctx parser versions,
Vue DevTools' lagging Vite DevTools range, CLI `cac` ranges, mkdist's optional
SFC transformer and floating-vue's optional Kit range. These are not a clean
peer-check claim. Keep the actual application/build/browser evidence distinct
from these warnings rather than broadly suppressing them.

On the upgraded stack, 64 affected controller/delivery tests pass in 16.92 s,
Explorer typecheck passes, and all eight production Chromium journeys pass in
92.89 s (`c1-upgraded-regressions.json`, `c1-browser.json`). The earlier eight
browser journeys took 44.45 s; both totals include build/setup and are not an
isolated startup benchmark. Native dock and packed-host checks still belong
to the following adapter slice. Opus reviewed selected upgrade sources with
no tools or writes (`opus-c1-stack.json`).
The affected Docus host prepares successfully. Workspace TypeScript now also
passes after declaring the Vue and Nitro development inputs previously
available through hoisting; the Nuxt module declares its existing Vue runtime
requirement as a host peer, without raising it above the previous Vue 3.5.39
baseline. Changed-file lint and final frozen install pass.

The native dock integration will require DevTools v4. This is an explicit
prepublication UI compatibility decision: on a v3 host, the new ready hook
does not fire and no native dock is registered. No permanent deprecated-tab
implementation will be introduced. Transport APIs and the independent layer
remain separate; this decision is not a Nuxt 5 migration or a removal of
non-DevTools consumption. The independently consumed, unpublished Explorer
layer now declares Nuxt `^4.6.3` and Vue `^3.5.44`; retain its default export
and avoid claiming an unverified older host range. The transport module's
independent compatibility contract is not raised merely for its developer UI.

Primary references refreshed on 2026-10-30:
[Nuxt 4.6.3](https://github.com/nuxt/nuxt/releases/tag/v4.6.3),
[DevTools v4 host requirements](https://nuxt.com/modules/devtools/upgrading-to-v4),
and [module migration](https://nuxt.com/modules/devtools/module-migration).
The official module guide explicitly describes the non-registering v3-host
behavior. Keep the lockfile and use the documented DevTools override on Nuxt 4;
do not follow the upgrade page's generic lockfile-deletion suggestion.

## Recommendation

Keep Nuxt UI and the existing Explorer product surface. Modernize its serving
contract and state ownership, then adopt the supported DevTools v4 dock APIs.
Use a separately verified Nuxt/UI update, targeting Nuxt 4.6.3 and Nuxt UI
4.12.0 as the currently observed stable candidates. Do not combine this work
with a Nuxt 5/Nitro 3 migration.

Devframe is a useful architectural foundation, not a reason to replace the UI
or route production OData traffic through a development RPC channel. Initially,
a same-origin iframe and thin v4 adapter are sufficient. A portable Devframe
definition becomes a subsequent bounded experiment when there is an actual
plain-Vite, standalone development, or other host consumer.

The first implementation slice should repair the executable Explorer baseline.
Neither a successful build nor an automatically bridged legacy tab proves that
the existing application journeys work.

## What exists today

| Owner | Current responsibility |
| --- | --- |
| `packages/explorer` | Client-rendered Nuxt layer/application; Nuxt UI controls; Overview, Services, Logs and Proxy workspaces; entity editor and schema graph |
| `packages/nuxt/src/devtools.ts` | Registers an iframe through `devtools:customTabs`; serves `./client` if present, otherwise starts an Explorer Nuxt process |
| `packages/proxy/src/api` | Config, schema, logs, metadata refresh, types and identity endpoints |
| `packages/proxy/src/api/odata.ts` | Actual OData forwarding, server-side policies and transport behavior |
| `packages/core` / `packages/metadata` | Portable OData operations, metadata ingestion/projection and log-store contracts |

The Explorer pins Nuxt 4.4.8, Vue 3.5.39 and Nuxt UI 4.9.0. The module uses
DevTools Kit 3.2.4. The resolved toolchain includes Vite 7.3.6. The earlier
Anthony Fu-based alternative was not historically reconstructed in this audit;
Nuxt UI is the verified current documented and implemented baseline.

The current workspace fallback uses port 3300 and guesses the application URL
from its configured port, defaulting to 3000. The iframe then goes to another
origin. The packaged-client branch expects a directory that the current Nuxt
module build configuration does not explicitly emit. A clean installed-consumer
proof is needed before treating that branch as working distribution behavior.

The published-shape Explorer layer is also an independent supported consumption
surface. All five ODX product packages remain unpublished. There is no released
Explorer package to deprecate, and this plan does not remove its layer export or
make it private.

## Executed audit and its limits

Local evidence directory:
`.artifacts/explorer-devtools-v4-audit-2026-10-30/`.
These are local synthetic artifacts, not repository source or registry releases.

| Check | Actual result | Meaning |
| --- | --- | --- |
| Focused Explorer layer, DevTools bridge and proxy-policy tests | 55 cases passed; one additional suite failed collection | Not a green combined test run |
| `packages/explorer/test/state.test.ts` | Cannot import Nuxt's `dist/app/types/augments` through `nuxt/app` | State assertions did not execute; repair the test/runtime boundary rather than silently skipping the file |
| Explorer strict typecheck | Passed, about 26 seconds | Existing TypeScript contracts compile |
| Fresh Explorer production build | Passed, about 40 seconds | Current application emits a runnable build |
| Rendered Chromium overview and service list | Rendered; local config/schema handlers supplied synthetic metadata | Screenshots and actual DOM inspection, not only a build claim |
| Open a service through the current card | Pointer/keyboard probe did not finish; screenshot capture also timed out after the attempt | Browser audit incomplete; isolate renderer, navigation and fixture factors before calling this a proven product root cause |
| Remaining entity, schema, editor and log journeys | Not completed by that browser run | No whole-Explorer functional approval |
| DevTools v4 dock / installed-consumer integration | Not run | Upstream API research is not local compatibility proof |
| Real SAP/BTP or customer services | Not used | Not required to begin the local migration |

`checks.json` records commands, baseline revision, timings and actual exits;
`tests.json` contains the combined Vitest result. `browser.json` explicitly
records the incomplete journey. `overview-desktop.png` and
`services-desktop.png` preserve the rendered baseline. The fixture configured
only a synthetic loopback upstream and mounted actual ODX config, schema and
log handlers plus `createODataHandler`. Service opening did not complete, so
that run does not prove an entity read through the proxy.

## Findings to address, not hide behind migration

### 1. Establish a dependable delivery and development-server contract

`devtools.ts` has a single mocked integration test. It does not prove asset
contents in an installed tarball, multiple applications, an occupied port,
actual listener URLs, base paths, HTTPS, HMR or shutdown.

Make prebuilt, same-origin assets the default for installed consumers. Maintain
an explicit source-development path for contributors, with an owned child
process, allocated port and actual host URL. Spike same-origin HMR forwarding
against an allocated child origin with an API back-proxy; choose the simpler
verified contributor path rather than assuming websocket proxying is free.
A missing asset bundle
must produce an actionable diagnostic, not a silently broken dock or an
unexpected dev-server launch inside `node_modules`.

### 2. Give state, effects and requests one application owner

`useODataState.ts` stores module-level mutable state and creates config watchers
inside its factory. `useEntityExplorer()` also creates watchers each time it is
called. Consumers invoke those factories from multiple components and from
asynchronous work. This makes watcher, timer and request ownership unclear.

The log interval is returned from `onMounted`; Vue does not use that return
value as an unmount cleanup. Explicit disposal is required. Read/schema
responses do not have a clear selection-generation guard or cancellation
contract, and completion can update state after selection has changed.

Use one app-scoped controller with an explicit disposal path. Retain simple
public composables as views over it. Capture service/entity/query identity
before each request; abort obsolete reads and reject stale completions. Cache
entries must use the captured identity. Keep secret-bearing session headers
ephemeral and isolate separate application instances.

### 3. Reconcile the Explorer's writes with current transport semantics

The editor and row deletion manually construct `?id=` requests. The proxy does
support a legacy single-ID rewrite, so this is not evidence that every write
fails. However, the UI still derives identity from `ID`/`Id`, tests it by
truthiness, and does not carry a typed composite-key contract. A key of numeric
zero can be treated as absent. Update and delete also omit the session headers
that reads apply, and do not visibly attach entity ETags. Failed deletion can
return without a user-visible error.

Before adding more controls, reuse existing core key/path construction and
define one Explorer HTTP adapter for request headers, response errors,
cancellation and concurrency. Do not invent a second OData transport/parser.
If a row lacks enough metadata for a safe operation, explain that limitation
and disable that operation. Keep an advanced request workbench deliberate;
changing its method without a payload is not equivalent to supported CRUD.

These are source-confirmed shortcomings. The interrupted browser run did not
prove their complete user-visible reproduction or their absence on every
backend. Targeted V2/V4 fixtures must establish that before a fix is accepted.

### 4. Expose errors and capabilities truthfully

Config and log fetchers silently ignore several non-success responses. A
production authorization failure can look like an empty or inactive tool.
Generation support is also inferred from the presence of a Node version.

Use explicit loading, empty, forbidden, disconnected, stale and failed states.
The server should declare supported operations. Keep SDK generation distinct
from production metadata refresh and keep the existing production authentication,
raw-metadata restrictions and log redaction. DevTools trust never grants SAP
production authorization. A same-origin iframe shares the host's cookie/storage
origin; it is not a security sandbox. Preserve server-side authorization.

### 5. Improve density after functional ownership is reliable

The current surface eagerly mounts workspaces using `v-show`, shares graph
state and includes substantial graph/editor functionality. Measure the initial
bundle, actual mount work and background requests before changing it.

Keep Nuxt UI. Make the embedded header compact while retaining standalone
identity and navigation. Add accessible labels to icon-only row actions,
keyboard-visible focus, predictable error recovery and contained scrolling.
Lazy-load graph layout and Shiki where that actually removes startup work.
Validate dock widths around 420/768px as well as desktop, both color modes and
real keyboard interaction. Avoid arbitrary pixel targets or a full visual rewrite.

## What upstream changes for us

The official Nuxt release feed reports DevTools 4.0.0 on October 27, Nuxt 4.6.3
and Nuxt UI 4.12.0 as the observed current stable releases. Recheck exact versions
when implementation begins; these are candidates, not an installed lockfile.

DevTools v4 requires the Nuxt 4.5+/Vite 8 generation. It supplies a dock-based
host on top of Vite DevTools. Module registration and process management move
to a ready-context API. Legacy bridges remain during v4, allowing a staged
migration rather than an immediate loss of the current tab. See the
[official module migration guide](https://devtools.nuxt.com/module/migration-v4)
and [application upgrade guide](https://devtools.nuxt.com/guide/upgrading-to-v4).

Devframe provides portable definitions and adapters; the browser UI remains
independent. Its asset model and Nuxt adapter allow a Nuxt SPA to be hosted as a
tool. Adopt that only when the extra portability pays for its package and
security surface. See [definition](https://devfra.me/guide/devframe-definition),
[client assets](https://devfra.me/guide/client-assets),
[Nuxt adapter](https://devfra.me/frameworks/nuxt) and
[Vite adapter](https://devfra.me/adapters/vite).

Its RPC and shared state are useful for future developer-only commands and
diagnostics. They must not silently expose live headers, credentials, arbitrary
backend URLs or production mutation access. Keep the current authenticated HTTP
plane for operational Explorer usage. See [security](https://devfra.me/guide/security)
and [scoped context](https://devfra.me/guide/scoped-context).

## Proposed target boundaries

| Surface | Keep or introduce | Boundary |
| --- | --- | --- |
| Explorer UI | Existing Nuxt layer/application and Nuxt UI | View state and interaction; no Node, BTP or arbitrary privileged RPC imports |
| Explorer runtime client | Small typed adapter inside Explorer | Existing authenticated HTTP endpoints, captured request identity, common errors/headers |
| App controller | One owner per Explorer app instance | State, cache, active requests, polling and disposal |
| Nuxt DevTools adapter | Thin module-owned registration and lifecycle | Dock/terminal API; no business request implementation |
| Prebuilt client distribution | Explicit build artifact and package export/manifest | Self-contained local assets; keep the existing public layer surface |
| Optional portable Devframe entry | Later dev-only adapter over selected diagnostics | No transitive Devframe dependency in core, metadata or production proxy |

Prefer a verified asset copy into the Nuxt package over removing the current
layer. In that model the Explorer becomes a build-time dependency of the Nuxt
package; static-client users need not install Nuxt UI, ELK or graph/editor source
to serve already-emitted files. Keep the separately consumable Explorer layer,
with Nuxt/Vue as host peers and its legitimate UI dependencies. An additive
asset export/manifest is the alternative if the packed spike proves it cheaper
without pulling the full layer runtime into static mode. Gate both delivery
modes on their actual dependency graphs and single Nuxt/Vue runtime resolution.
Installed users must not need the contributor's second Nuxt server just to
inspect OData.

## Implementation sequence and exit gates

### Slice A — make the current baseline executable

Files: Explorer Vitest config/state fixtures, the controller/composables and
focused browser fixtures; start without a dependency update.

1. Isolate the missing Nuxt import. Do not assume that another `prepare` or a
   broad dependency reinstall fixes it: the existing typecheck already passes.
   Separate pure Vue state tests from tests that need a real Nuxt app context.
2. Reproduce service opening with an instrumented minimal fixture and distinguish
   card hit targets, graph initialization and driver behavior. Keep failures
   visible; no forced DOM click is evidence of a usable card.
3. Add actual normal usage: select service/entity, execute query, open schema,
   inspect traffic/trace, show an upstream failure, recover, change entity while
   a read is delayed, then close/unmount.
4. Establish a minimal mutation guard now: recognize numeric zero as a valid
   key, reject update/delete without safely resolved identity, prevent an edit
   becoming a collection POST, and report failed deletion. Prove this only
   against synthetic fixtures before broader mutation work in D.

Exit A-baseline: the state suite executes and the combined focused run passes
without collection failures; service-to-entity read succeeds through actual
pointer and keyboard input. An explanation that the timeout was only in the
driver does not substitute for that passing journey.

Then A-controller: correct effect disposal and latest-request ownership with
the delayed-selection tests. Test actual 401/403 config/log responses as visible
denied states, not empty lists. Exit: delayed selection stays authoritative, one
poll owner remains and unmount/HMR stops owned work. Report actual counts.

### Slice B — make static delivery deterministic

Files: Explorer build/package metadata, Nuxt module build config,
`packages/nuxt/src/devtools.ts`, its tests and a clean installed consumer.

1. Emit a verified static client and identify its owning package/export.
2. Serve installed assets at the host-owned Explorer URL, with no fixed port or
   child server. Test nested asset paths and refresh/deep links.
3. Define the contributor-mode contract now, but implement new port/process/HMR
   lifecycle ownership in C on the final host stack, rather than writing it
   twice against Vite 7 and Vite 8.
4. Make missing assets a bounded diagnostic. Preserve the layer API.

Exit: clean packed consumer outside the workspace opens the UI and reads a
synthetic service; no repository paths or unpublished-registry lookup leaks.
Verify a non-root application base, actual API-base discovery and deep-link
refresh. Static mode starts no child server. The layer uses one host Nuxt/Vue
runtime; static-client mode brings no additional UI framework dependency graph.
Ordinary production builds neither register the DevTools route nor retain its
development assets or contributor proxy; the separate operational Explorer
layer remains available deliberately. Preserve production endpoint policy.

### Slice C — update the host stack and register a native v4 dock

Files: relevant workspace manifests/lockfile, Explorer/Nuxt module config,
thin DevTools adapter and compatibility/browser fixtures.

0. Record the host-floor decision before implementation: recommend native v4
   integration on Nuxt 4.5+, while retaining the layer/transport's wider existing
   range where verified. The legacy-tab fixture is a transitional compatibility
   check, not a commitment to a second renderer forever. Explicitly document any
   resulting package peer-range change before adopting it.
1. Upgrade Nuxt and its coherent framework tooling as one bounded change,
   targeting the observed stable Nuxt 4.6.3. Resolve and record actual Vite 8
   and Node compatibility. Keep the lockfile; do not force Vite 8 into Nuxt 4.4.
2. Upgrade Nuxt UI 4.9 to 4.12 separately enough to attribute failures. Inspect
   tables, overlays, menus, theme and app providers in the real Explorer.
   Charts are optional and not a reason to add unrelated dashboard work.
   Rerun A's pointer/keyboard and error journeys plus B's installed-consumer
   asset/dependency checks after the framework update and again after Nuxt UI.
3. Configure DevTools 4 deliberately: Nuxt 4's bundled default is not proof of
   v4 selection. Use the official package-manager override and verify resolution.
4. Use `onDevtoolsReady`, a registered iframe dock in the Nuxt group and the
   terminal lifecycle host for contributor processes. Implement actual listener
   discovery, allocated ports, the chosen API/HMR path and disposal here. Avoid old shims in the
   v4 path and remove the current untyped custom-tab call there.
5. Prove the still-supported v3 host path rather than guessing kit compatibility.
   Decide any new minimum Nuxt version explicitly before first publication;
   do not silently drop the current layer's declared range.

Exit: record resolved DevTools 4, Vite 8 and supported Node engines; a real v4 host
shows one working ODX dock, API calls remain same-origin and
authorized, no deprecated calls on that path, reconnect/restart works, disabled
DevTools and prepare/build do not spawn a UI server. Two contributor hosts
coexist, occupied ports are handled and restart/shutdown closes owned processes.
Recheck B's production-exclusion, dependency and nested-base gates on the final
stack. The retained legacy fixture
passes or the documented compatibility decision is made before release.

### Slice D — reconcile keys, writes and capabilities

Files: Explorer runtime client/editor/table, existing core protocol utilities
and proxy config capability projection where required.

1. Capture typed keys from metadata; cover zero, escaped strings and composite
   keys in both V2 and V4. Use existing core builders and version negotiation.
2. Apply session headers consistently, carry ETags, report 409/412 conflicts
   without overwriting and make unsupported operations explicit.
3. Correct silent delete failures and clarify the raw-request/body editor.
   Do not send a bodyless method merely because the selector allows it.
4. Project server-owned capabilities and enforce the existing server policy.
   The ordinary UI must not offer a write denied by that capability; an advanced
   workbench cannot bypass authorization. Show metadata refresh versus type
   generation truthfully. Do not redefine production auth in this migration.
5. Assess unbounded reads in the fixture. If they cause a demonstrated problem,
   bound pages and follow validated continuations here; otherwise ship paging
   as a separate feature slice. Preserve selection identity through refresh.

Exit: synthetic HTTP contracts prove request methods, typed paths, headers,
concurrency and error recovery (plus continuation when included); browser assertions verify visible
outcomes. Keep SAP-specific policies distinct from generic OData support.

### Slice E — embedded UX and startup costs

Files: existing app/tabs, tables, graph/editor loading boundaries and theme.

Take the performance baseline after C on the final Nuxt/Vite/UI stack. Compare
the same synthetic service and journeys before/after at embedded and
desktop widths. Improve labels, keyboard actions, recovery, compact embedded
chrome, theme alignment and scroll containment. Add a service/entity quick
switcher only if it simplifies repeated work. Lazy-load optional graph/editor
code and pause refresh while hidden, with explicit resume reconciliation.

Exit: real pointer/keyboard tasks work, no serious accessibility violations in
the changed views, stable layout during service/entity changes, recorded
startup bytes/mount/first-ready timings. Set performance budgets from measured
baselines and meaningful growth policy, not arbitrary byte limits.

### Slice F — optional portable Devframe proof

Only after B–E stabilize: package one diagnostic view as a Devframe definition
and mount it in a non-Nuxt development host. Keep the same UI and protocol
owners. Verify runtime base discovery, trust, disposal, no secret-bearing
snapshot export and no production/worker dependency regression. Drop the
experiment if it only duplicates the Nuxt adapter without a real consumer.

## Proportional verification matrix

| Area | Required evidence |
| --- | --- |
| Source state | Executable app/controller tests, effect disposal, stale read/schema/cache protection |
| HTTP | Local actual proxy handlers with synthetic V2/V4 upstream; keys, writes, ETags, pagination, denied operations |
| Packaging | Clean pnpm installed consumer; tarball assets and layer entry; npm smoke at the distribution checkpoint |
| Host integration | Current supported v3 host and new native v4 host; actual dock/iframe; custom host port/base path; restart/close |
| UI | Chromium desktop and narrow embedded owner, light/dark, keyboard, query/schema/log/editor/recovery journeys |
| Portability | Existing Node and edge deployment checks where adapter/import boundaries change; no blanket full-suite repetition per small edit |
| Integration handoff | Once the bounded migration is complete: ordinary ODX verification plus affected packed-consumer/UI checks, with actual receipts |

Start with Chromium. Broaden browser coverage when a concrete iframe,
clipboard, focus, streaming or transport concern justifies it. Do not require
three complete browser engines or real BTP acceptance to fix a local UI.

## Opus discussion: accepted and corrected

Accepted: packaging/serving before native registration; preserve HTTP policy;
fix state/request ownership; retain Nuxt UI; avoid a Devframe-wide rewrite;
prove the installed-consumer and actual user journeys.

Corrected or deferred: no Explorer package removal, npm deprecation or private
flag change; the packages are unpublished and the layer is a valid product
surface. Nuxt/UI upgrades are part of the plan, not indefinitely deferred.
The existing proxy already handles the legacy `?id=` path and CSRF, so client
shortcomings are not automatically server transport failures. Core already
provides protocol builders; do not introduce a competing key/query engine.
Treat the exact state-test failure cause and service-selection browser failure
as unresolved diagnosis, not proven by a static review. Avoid architecture
changes based only on hypotheses about production authorization or identity.

The final Opus review accepted the direction and requested tighter gates. Those
are incorporated: contributor-process work moves onto the final v4 stack;
installed-consumer and interaction checks repeat after framework/UI updates;
production exclusion and layer-versus-static dependency graphs are explicit;
the host-floor decision happens before C; unsafe unresolved writes are guarded
in A rather than waiting for D. Baseline repair and controller changes have
separate exits, and performance comparisons use the post-upgrade toolchain.
The final review and initial analysis remain separate local artifacts;
`opus-plan-review.md` records the review before these responses were applied.

## Sources

- [Nuxt DevTools stable release](https://github.com/nuxt/devtools/releases/tag/v4.0.0)
- [Nuxt stable candidate](https://github.com/nuxt/nuxt/releases/tag/v4.6.3)
- [Nuxt UI stable candidate](https://github.com/nuxt/ui/releases/tag/v4.12.0)
- [DevTools module migration](https://devtools.nuxt.com/module/migration-v4)
- [DevTools host upgrade](https://devtools.nuxt.com/guide/upgrading-to-v4)
- [Devframe introduction](https://devfra.me/guide)
- [Devframe definition](https://devfra.me/guide/devframe-definition)
- [Devframe client assets](https://devfra.me/guide/client-assets)
- [Devframe Nuxt adapter](https://devfra.me/frameworks/nuxt)
- [Devframe Vite adapter](https://devfra.me/adapters/vite)
- [Devframe security](https://devfra.me/guide/security)
- [Devframe RPC](https://devfra.me/guide/rpc)
- [Devframe deep linking](https://devfra.me/guide/deep-linking)
- [pnpm configuration and environment](https://pnpm.io/configuring)

Upstream documentation changes independently of this audit. Verify actual
resolved package contracts and the pinned host matrix during implementation.
