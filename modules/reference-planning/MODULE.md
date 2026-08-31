# Reference Planning

- Purpose: Prove that authoritative application evidence is the exact media intended for the exact provider payload location.
- Interface: `modules/reference-planning/index.ts`
- Errors: `modules/reference-planning/errors.ts`
- Acceptance: `modules/reference-planning/reference-planning.test.ts`

Reference Planning validates application-relative containment, authority reasons, declared and detected media kind, SHA-256, actual media properties, and locked JSON Pointer destinations. Hashing and inspection use the same byte snapshot. Built-in PNG inspection requires the complete eight-byte signature and an IHDR header. Built-in MP4 inspection requires a parsed top-level container, `moov`/`trak`/`mdia` hierarchy, a recognized video sample description, complete timing/chunk/sample tables, chunk offsets inside non-empty `mdat` evidence, and safe dimensions and duration; marker-shaped byte strings are refused. When bytes have a built-in signature, an injected inspector cannot relabel their media type. An injected Media Inspector for another application format must prove its recognized kind and supported exact media type; both are frozen into the Reference Plan and carried unchanged to Generation. Unknown bytes and kind/type contradictions are refused. An image cannot satisfy a Seedance video requirement.
