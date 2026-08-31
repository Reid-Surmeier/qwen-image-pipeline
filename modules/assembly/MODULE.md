# Assembly

- Purpose: Deterministically compose a hash-locked donor and Exact Copy over a hash-locked baseline only inside the owned region.
- Interface: `modules/assembly/index.ts`
- Errors: `modules/assembly/errors.ts`
- Acceptance: `modules/assembly/assembly.test.ts`

Assembly accepts normalized raster evidence, verifies every declared hash, applies the donor only inside the owned region, then applies every hash-locked Exact Copy pixel. Exact Copy coordinates must be safe integers and each pixel must contain exactly four integer RGBA channels before composition. It returns separately hashed output and an input-hash report; it does not write the Run Record or declare a Verified Candidate.
