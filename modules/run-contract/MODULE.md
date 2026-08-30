# Run Contract

- Purpose: Turn valid planning documents and proved references into one canonical immutable Planned Run.
- Interface: `modules/run-contract/index.ts`
- Errors: `modules/run-contract/errors.ts`
- Acceptance: `modules/run-contract/run-contract.test.ts`

Run Contract rejects secret material, a mismatched Tool Lock, unapproved Procedures, unsafe paths, unprovable counts, and budget excess before sealing a Run Request. It owns canonical serialization and the request SHA-256. It does not reserve an attempt or persist a Run Record.
