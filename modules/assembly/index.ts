import type { Effect } from "effect"

import { assembleRaster } from "./assembly.js"
import type { AssemblyError } from "./errors.js"
import { inspectAssemblyFailure } from "./errors.js"
import type { AssemblyInput, AssemblyResult, ExactCopyPixel, OwnedRegion, RasterEvidence } from "./types.js"

export const assemble: (input: AssemblyInput) => Effect.Effect<AssemblyResult, AssemblyError> = assembleRaster

export { inspectAssemblyFailure }
export type { AssemblyError, AssemblyErrorCode, AssemblyFailureEvidence } from "./errors.js"
export type { AssemblyInput, AssemblyResult, ExactCopyPixel, OwnedRegion, RasterEvidence } from "./types.js"
