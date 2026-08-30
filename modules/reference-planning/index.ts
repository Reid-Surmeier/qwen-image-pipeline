import type { Effect } from "effect"

import type {
  ApplicationReadError,
  MediaInspectionError,
  ReferencePlanningError,
} from "./errors.js"
import { inspectSnapshot, planReferenceInputs } from "./reference-planning.js"
import type {
  ApplicationFilesService,
  MediaInspectorService,
  MediaProperties,
  ReferencePlan,
  ReferencePlanningInput,
} from "./types.js"

export const planReferences: (
  input: ReferencePlanningInput,
) => Effect.Effect<
  ReferencePlan,
  ReferencePlanningError | ApplicationReadError | MediaInspectionError,
  ApplicationFilesService | MediaInspectorService
> = planReferenceInputs

export const byteMediaInspector: MediaInspectorService = {
  inspect: inspectSnapshot,
}

export {
  ApplicationReadError,
  MediaInspectionError,
  ReferencePlanningError,
} from "./errors.js"
export {
  ApplicationFiles,
  MediaInspector,
} from "./types.js"
export type {
  ApplicationFilesService,
  FileSnapshot,
  LockedReference,
  MediaInspectorService,
  MediaKind,
  MediaProperties,
  ReferenceCandidate,
  ReferencePlan,
  ReferencePlanningInput,
  ReferenceRequirement,
} from "./types.js"
