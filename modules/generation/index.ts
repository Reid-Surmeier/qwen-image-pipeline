import type { Effect } from "effect"

import type { SubmissionPermit } from "../run-record/index.js"
import type { GenerationError } from "./errors.js"
import { invokeGeneration, prepareGeneration } from "./generation.js"
import type {
  GeneratedArtifact,
  GenerationAdapterService,
  GenerationReference,
  GenerationResult,
  PreparedGeneration,
} from "./types.js"

export const prepare: (
  request: import("../run-contract/index.js").CanonicalRunRequest,
  references: ReadonlyArray<GenerationReference>,
) => Effect.Effect<PreparedGeneration, GenerationError> = prepareGeneration

export const invoke: (
  prepared: PreparedGeneration,
  permit: SubmissionPermit,
) => Effect.Effect<GenerationResult, GenerationError | import("../run-record/index.js").RunRecordError, GenerationAdapterService> = invokeGeneration

export { GenerationError } from "./errors.js"
export type { GenerationErrorCode } from "./errors.js"
export { GenerationAdapter } from "./types.js"
export type {
  GeneratedArtifact,
  GenerationAdapterService,
  GenerationReference,
  GenerationResult,
  PreparedGeneration,
} from "./types.js"
