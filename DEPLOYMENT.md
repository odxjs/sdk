# Deployment

ODX supports local Nuxt development and a SAP BTP Cloud Foundry full-stack
deployment.

## Local Development

Install dependencies:

```bash
pnpm install
```

Prepare generated Nuxt/module state:

```bash
pnpm run dev:prepare
```

Start the playground:

```bash
pnpm run dev
```

Start the Docus documentation site:

```bash
pnpm run docs
```

Regenerate API reference metadata:

```bash
pnpm run docs:api
```

Open Nuxt DevTools v4 and choose **Nuxt → ODX**. An installed module serves its
bundled Explorer at `<appBase>/__odx__/client/` without starting another process.
In a repository source host, opening **ODX** starts the development client
automatically on an allocated port. A status view offers terminal access;
failed starts show **Retry** and retain their terminal output until the next
attempt or host close. Its iframe and HMR use the host's Vite asset mount, for
example `/console/_nuxt/odx-explorer/`. Business requests remain on the host.
The running client appears in native Terminals; after explicitly terminating
it, reopen ODX and choose **Retry** to start a fresh client. Each host owns a temporary build/cache directory,
reused for its client restarts and removed when the host closes. Nuxt DevTools' normal
local authorization remains enabled. No fixed port 3300 is reserved by this
integration; standalone Explorer development can still use its own default.

Verify the actual native source-host interaction independently of the static
installed-consumer check:

```bash
pnpm --filter @me-tools/odx-nuxt test:explorer-native
```

This starts owned local hosts and Chromium against synthetic OData. It exercises
local authorization, native launch, data/schema/log/proxy navigation, same-origin
HMR, termination and relaunch. Receipts and screenshots go to the ignored
`.artifacts/explorer-native-host/`; no code or authorization token is persisted.
Pass an output directory followed by `--root-base` to exercise the ordinary
localhost/root host, or `--fail-first` to inject one child-process failure and
check retained terminal diagnostics plus explicit Retry. The default uses a
nested app base and an explicit loopback host. Neither path clicks a launcher.

Local Explorer endpoints are optimized for developer feedback. They can expose
resolved config, local generated types, raw metadata XML, and in-memory traffic
logs. Development logs still need secret redaction and payload limits for
outbound headers, auth/session/CSRF data, request bodies, and response bodies.
Traffic logs use the core `OdxLogStore` boundary with the memory store by
default. `devtools.maxLogs` controls local retention count, `devtools.logPayloads`
can omit request/response bodies, and `devtools.maxPayloadBytes` bounds each
stored payload preview.

Local development can opt into SQL-backed Explorer traffic history with:

```bash
NUXT_ODATA_DEVTOOLS_LOG_STORE=sql
NUXT_ODATA_DEVTOOLS_LOG_DB_CONNECTOR=sqlite
NUXT_ODATA_DEVTOOLS_LOG_DB_PATH=.odx/explorer-logs.sqlite
```

SQLite is only appropriate for local development or explicit single-instance
demos. It is not safe for BTP multi-instance production deployments because
each application instance has its own filesystem and locking behavior.

## Build

`build:deployment` builds the Explorer and proxy runtimes, adjusts generated
Nitro package metadata, and creates an MTA archive. The root `build` command is
reserved for the publishable npm packages.

The Explorer's package build emits a verified static client using temporary
Nuxt/Nitro outputs. Deployment therefore runs `nuxi build` in the Explorer
package explicitly to create its standalone `.output/server` runtime; it does
not reuse an earlier development or browser-test output. To check that build
locally without creating an MTA archive or deploying:

```bash
pnpm --filter @me-tools/odx-explorer exec nuxi build
```

```bash
pnpm run build:deployment
```

The resulting archive is written to:

```txt
mta_archives/odx-fullstack.mtar
```

## Deploy

Deploy the generated MTA archive to Cloud Foundry:

```bash
pnpm run deploy
```

The script runs:

```bash
cf deploy mta_archives/odx-fullstack.mtar
```

## MTA Modules

`mta.yaml` defines three deployable modules.

### `odx-approuter`

Path: `packages/approuter`

Purpose:

- Authenticated edge entry point.
- Routes `/api/odx/*` to the proxy.
- Routes `/explorer/*` to the Explorer UI.
- Routes deployed Explorer client assets under `/__odx__/client`.
- Routes only the supported `/__odx__` runtime APIs to the proxy.
- Forwards auth tokens to backend destinations.

### `odx-proxy`

Path: `packages/proxy/.output`

Purpose:

- Runs the Nitro-built proxy server with `node server/index.mjs`.
- Resolves OData backends from BTP destinations, absolute URLs, or local
  fallbacks.
- Handles XSUAA validation, destination lookup, rules, hooks, headers, and
  telemetry.

The local destination fallback is available only when `NODE_ENV` is explicitly
`development` or `test`. Production, staging, unset, and custom environments
stop the request when Destination/XSUAA bindings are missing or destination
lookup fails; ODX does not silently route deployment traffic to
`/sap/opu/odata/sap`.

### `odx-explorer`

Path: `packages/explorer/.output`

Purpose:

- Runs the Nitro-built Explorer UI with `node server/index.mjs`.
- Provides the authenticated browser workbench for services, schemas, traffic,
  entities, and proxy traces.

## BTP Resources

`mta.yaml` binds:

- `odx-xsuaa`: XSUAA application service using `xs-security.json`.
- `odx-destination`: Destination service for managed backend destinations.
- `odx-connectivity`: Connectivity service for on-premise destinations.

For a destination whose `ProxyType` is `OnPremise`, `odx-proxy` requires the
Connectivity binding to provide `onpremise_proxy_host` and
`onpremise_proxy_http_port`. The deprecated `onpremise_proxy_port` is accepted
only as a compatibility fallback. ODX does not guess a region-specific proxy
host or default port: incomplete or invalid binding data stops destination
resolution. Runtime metadata refreshes and requests, including SAP CSRF
preflights, are then tunneled through that authenticated HTTP proxy.
`PrincipalPropagation` destinations additionally
receive `SAP-Connectivity-Authentication` when an inbound user token exists.

Persistent production Explorer logs require an additional bound SQL database
for `odx-proxy`. The repository does not mandate a specific BTP SQL provider;
operators should bind the chosen managed SQL service, expose its connection URL
to the proxy as `NUXT_ODATA_DEVTOOLS_LOG_DB_URL`, and set:

```bash
NUXT_ODATA_DEVTOOLS_LOG_STORE=sql
NUXT_ODATA_DEVTOOLS_LOG_DB_CONNECTOR=postgresql
```

The db0 PostgreSQL connector requires the `pg` runtime package for deployments
that select PostgreSQL. Keep database credentials in BTP service bindings or
environment variables, not in checked-in configuration.

`xs-security.json` currently configures:

- dedicated tenant mode
- `employee_id` and `company_id` user attributes
- an `odx_user` role template
- token exchange support
- redirect URI patterns for BTP, Cloud Foundry, and SAP Business Application
  Studio style hosts

## AppRouter Routes

`packages/approuter/xs-app.json` declares:

| Source | Destination | Auth |
| --- | --- | --- |
| `^/api/odx/(.*)$` | `odx-proxy-backend` | XSUAA |
| `^/__odx__/client$` | `odx-explorer-ui` | XSUAA |
| `^/__odx__/client/(.*)$` | `odx-explorer-ui` | XSUAA |
| `^/__odx__/(config\|logs\|schema\|generate\|types\|me)(/.*\|)$` | `odx-proxy-backend` | XSUAA |
| `^/explorer/(.*)$` | `odx-explorer-ui` | XSUAA |

The welcome file is `/explorer/`.

The deployed Explorer is not the Nuxt DevTools integration. It is a standalone
browser app served behind AppRouter/XSUAA. The `/__odx__/client/*` route serves
that UI. The narrowed `/__odx__/<endpoint>` proxy route supports the standalone
Explorer's same-origin runtime API calls without swallowing client assets.

After AppRouter authentication, the proxy still enforces production Explorer
endpoint policy:

- `/__odx__/config` returns only top-level `basePath`, `mode`, and `services`.
  Service entries are limited to `name`, `route`, `icon`, `strategy`,
  `proxyMode`, `entities`, `isGenerated`, `version`, and `metadata`. The
  `metadata` object is limited to runtime cache state: `status`, `source`,
  `stale`, `staleReason`, `refreshedAt`, `timestamp`, `hash`, `bytes`, and
  optional `message`.
- Backend URLs, destinations, auth, outbound headers, rules, unknown service
  fields, global secrets, runtime paths, hooks, DevTools config,
  `forwardAuthHeader`, and `versions.node` are redacted or omitted.
- `/__odx__/schema` serves parsed cached metadata only and rejects raw metadata
  XML.
- `/__odx__/generate` refreshes runtime metadata cache state only. It uses the
  production-compatible service resolution path to fetch `$metadata`, reports
  stale, timestamp, hash, byte count, and source information, and falls back to
  stale cache when the backend is unreachable.
- `/__odx__/types` returns `403`; production does not expose generated type
  artifacts.
- `/__odx__/logs` returns an empty list and rejects `DELETE` unless persistent
  SQL log storage is explicitly configured. With SQL storage enabled, it lists
  and clears redacted logs behind the existing log store and redaction
  boundary. Production request and response payload bodies are omitted by
  default.
- `/__odx__/me` returns sanitized SAP user context without raw token data.

## Service Configuration In Deployment

Configuration can come from:

- checked-in Nuxt `odata` options
- environment variables
- BTP user-provided service credentials read from `VCAP_SERVICES`
- BTP Destination service entries

Use environment variables or BTP services for deployment-specific secrets and
backend URLs. Do not commit credentials, tenant-specific destinations, or local
`default-env.json`.

SAP CSRF preparation is opt-in for proxied mutations. Enable it on SAP
services and select `GET` only when the backend does not support the default
`HEAD` token request:

```ts
export default defineNuxtConfig({
  odata: {
    services: [
      {
        name: 'SapCatalog',
        url: '',
        destination: 'SAP_CATALOG',
        csrf: { mode: 'sap', fetchMethod: 'GET' },
      },
      { name: 'StandardOData', url: 'https://example.test/odata' },
    ],
  },
})
```

The matching environment overrides are
`NUXT_ODATA_SERVICES_<NAME>_CSRF_MODE` (`sap` or `none`) and
`NUXT_ODATA_SERVICES_<NAME>_CSRF_FETCH_METHOD` (`HEAD` or `GET`). Token and
session cookies stay inside the proxy request and are never browser config.

## Metadata And Type Cache

Remote EDMX metadata is cached in two places:

- `.nuxt/odx/temp/<service>.edmx` for generated Nuxt runtime/build state.
- `.odx/cache/<service>.edmx` as a persistent local fallback cache across
  `.nuxt` cleanup.

Both locations are local generated artifacts. Do not commit them unless a future
release intentionally changes that policy. If stale metadata causes local type
generation or runtime schema checks to disagree with the backend, delete
`.nuxt/odx/temp/` first. Delete the matching `.odx/cache/<service>.edmx` file as
well only when you want the next prepare/build to refetch metadata instead of
using the local fallback.

Production Explorer metadata refresh is not TypeScript SDK generation. It
updates cached EDMX state for schema inspection only and never runs `odata2ts`
or writes generated TypeScript files in the deployed Nitro runtime. Generated
SDK files remain development/build/CI artifacts and require a new deployment to
change application types.

## Standalone AppRouter Push

The MTA remains the complete deployment contract. When the proxy and Explorer
are already deployed independently, `packages/approuter/manifest.yml` can push
only the AppRouter without embedding a region, tenant, or service-instance
name:

```bash
cf push -f packages/approuter/manifest.yml \
  --var odx_proxy_url=https://<proxy-route> \
  --var odx_explorer_url=https://<explorer-route> \
  --var xsuaa_service_name=<xsuaa-service-instance>
```

Cloud Foundry resolves the `((variable))` placeholders before staging. Both
route destinations use the same names as `xs-app.json` and forward the XSUAA
token to their owning backend. Keep deployment-specific values in CLI `--var`
arguments or an uncommitted `--vars-file`; do not restore a checked-in regional
host.

## Operational Checks

Before deployment-sensitive changes, run the relevant checks:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm --filter odx-approuter run verify
pnpm run build:deployment
```

For documentation-only changes, `git diff --check` is usually enough.

After deployment, useful Cloud Foundry checks are:

```bash
cf apps
cf env odx-proxy
cf env odx-approuter
cf logs odx-proxy --recent
cf logs odx-approuter --recent
```

## Common Failure Points

- Destination name in service config does not match BTP Cockpit.
- XSUAA or Destination service is not bound to the expected module.
- Authorization header is not forwarded by the approuter destination.
- On-premise destination requires Connectivity service binding.
- Metadata generation cannot reach `$metadata` and no `.odx/cache` fallback
  exists.
- `rejectUnauthorized` behavior differs between local development and deployed
  environments.
