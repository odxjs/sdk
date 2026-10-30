# Research

Durable product and architecture research for the ODX ecosystem lives here.
Research artifacts are evidence and decision support, not implementation
authority. Public behavior remains owned by source code, tests, and the
root-level project documentation.

## Active research

- [`explorer-devtools-v4.md`](./explorer-devtools-v4.md) - current Explorer audit,
  Opus-reviewed serving/state boundaries and the staged Nuxt DevTools v4 plan.
- [`nuxt-fiori/`](./nuxt-fiori/) - metadata-driven Smart Components and a
  possible Nuxt Fiori application framework built on ODX.
- [`evlog-observability-evaluation.md`](./evlog-observability-evaluation.md) -
  evidence, boundaries, and pilot gates for optional cross-layer operational
  observability with evlog.

## Future ideas (not scheduled)

### Query-specific OData typing, inspired by Reylo

Recorded 2026-10-22. Parked for possible future evaluation; not an active work
item, release gate, dependency decision, or commitment to a new API.

[Reylo](https://reylo.dev/) derives SQL query parameter and result types from
SQL and the database schema through TypeScript content mappers. The transferable
idea is more precise types and diagnostics for individual OData queries, not
adopting its SQL runtime or bypassing the OData service boundary.

ODX already derives service/entity models from metadata through `odata2ts` and
verifies generated-output reuse with content hashes. Its current query contract
still accepts string expressions for `$filter`, `$expand`, and `$orderby`;
`$select` does not narrow the declared result from the complete entity model.
A future investigation could evaluate metadata-aware query validation and
projection-specific result types against that existing implementation.

Revisit only when a concrete consumer need justifies the tooling and API cost.
Prefer an incremental, backward-compatible improvement; a content mapper would
need to demonstrate value over existing generation and compatibility with the
supported Nuxt/Vue/TypeScript toolchain. No Reylo dependency, compiler migration,
or implementation work is planned now.
