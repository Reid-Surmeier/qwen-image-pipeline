import { Effect } from "effect"

import { assembleRaster } from "./assembly.js"
import type { AssemblyError, AssemblyFailureEvidence } from "./errors.js"
import { inspectAssemblyFailureSync } from "./errors.js"
import type { AssemblyInput, AssemblyResult, ExactCopyPixel, OwnedRegion, RasterEvidence } from "./types.js"

export const assemble: (input: AssemblyInput) => Effect.Effect<AssemblyResult, AssemblyError> = assembleRaster

export const inspectAssemblyFailure = (
  error: unknown,
): Effect.Effect<AssemblyFailureEvidence | undefined> => Effect.sync(() => inspectAssemblyFailureSync(error))
export type { AssemblyError, AssemblyErrorCode, AssemblyFailureEvidence } from "./errors.js"
export type { AssemblyInput, AssemblyResult, ExactCopyPixel, OwnedRegion, RasterEvidence } from "./types.js"
