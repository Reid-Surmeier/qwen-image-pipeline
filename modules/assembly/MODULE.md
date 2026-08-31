# Assembly

- Purpose: Deterministically combine authoritative baseline pixels, Exact Copy, and selected donor regions.
- Interface: `modules/assembly/index.ts`
- Errors: `modules/assembly/errors.ts`
- Acceptance: `modules/assembly/assembly.test.ts`

Assembly deterministically places approved donor regions and verbatim Exact Copy onto a baseline image while guaranteeing zero changed pixels outside declared regions.
