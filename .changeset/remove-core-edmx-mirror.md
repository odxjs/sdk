---
'@odxjs/core': major
---

Remove the legacy regex- and file-based EDMX extraction exports from the server
entry. Parse metadata with `@odxjs/metadata` and project the resulting
CSDL document through the existing core server adapters.
