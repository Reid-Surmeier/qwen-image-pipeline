# Run Contract

- Purpose: Turn valid planning documents and proved references into one canonical immutable Planned Run.
- Interface: `modules/run-contract/index.ts`
- Errors: `modules/run-contract/errors.ts`
- Acceptance: `modules/run-contract/run-contract.test.ts`

Run Contract rejects secret material, a mismatched Tool Lock, unapproved Procedures, unsafe paths, unprovable counts, budget excess, and malformed successor relationships before sealing a Run Request. A successor relationship is part of the canonical request rather than side data supplied during reservation.

A Qwen Image Objective may declare an Assembly plan. When present, `required` is exactly `true`; `baselineReferenceSlot` names a locked image reference; the single integer `ownedRegion` stays inside that reference's inspected dimensions; and `exactCopy` contains one or more pixels inside the region. Each pixel SHA-256 binds `JSON.stringify({ x, y, rgba })` after Run Contract has normalized those three fields. Invalid shape, hash drift, and out-of-region evidence fail with `ASSEMBLY_PLAN_INVALID`.

A Seedance Objective must declare a Video Plan. Assembly may be absent only when its exact machine-readable decision says `required: false` and `pixelOwnership: "none-authoritative"`; a vague or missing assertion is refused. The same plan freezes expected width, height, duration, and audio presence for independent output verification. Qwen objectives cannot carry a Video Plan, and Seedance objectives cannot carry a Qwen Assembly plan.

Run Contract owns canonical serialization and the request SHA-256. It does not reserve an attempt or persist a Run Record.
