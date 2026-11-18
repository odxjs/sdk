---
'@odxjs/core': minor
'@odxjs/proxy': minor
'@odxjs/nuxt': minor
---

Add a production-safe SAP CSRF mutation contract for proxied services. Token
preflight, request-scoped session cookies, ETags, and `If-Match` now work in
both buffered and streamed proxy modes, with explicit per-service opt-in and
HEAD/GET configuration. Generic OData proxy behavior remains unchanged.
