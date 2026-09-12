# Assembly

- Purpose: Deterministically compose a hash-locked donor and Exact Copy over a hash-locked baseline only inside the owned region.
- Interface: `modules/assembly/index.ts`
- Errors: `modules/assembly/errors.ts`
- Acceptance: `modules/assembly/assembly.test.ts`

Assembly accepts normalized raster evidence, verifies every declared hash, applies the donor only inside the owned region, then applies every hash-locked Exact Copy pixel. Exact Copy coordinates must be safe integers and each pixel must contain exactly four integer RGBA channels before composition. Its interface preserves `AssemblyError` as a runtime value for consumers that inspect the documented error class. It returns separately hashed output and an input-hash report; it does not write the Run Record or declare a Verified Candidate.

## Muse port (Issues #90–93)

Issue #91 adds `assembleProductRecipe` for the preserved product Assembly kernel. The application supplies the complete original settings, layouts, fonts, packets and reconciled donor records with hashes. Empty work and missing/changed evidence refuse before output. Exact source slices are frozen by `procedures/muse/source-manifest.json`; replay compares the original caller and saved output. New outputs remain unapproved, with the existing 0.70 Assembly and 0.75 final OCR thresholds reported separately.
