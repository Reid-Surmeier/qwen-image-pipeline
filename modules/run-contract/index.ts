import type { Effect } from "effect"

import type {
  ApplicationFilesService,
  ApplicationReadError,
  MediaInspectorService,
  MediaInspectionError,
  ReferencePlanningError,
} from "../reference-planning/index.js"
import { compileDocuments } from "./run-contract.js"
import type { RunContractError } from "./errors.js"
import type {
  PlannedRun,
  PlanningIdentityService,
  RawPlanningDocuments,
} from "./types.js"

export const compilePlannedRun: (
  input: RawPlanningDocuments,
) => Effect.Effect<
  PlannedRun,
  | RunContractError
  | ReferencePlanningError
  | ApplicationReadError
  | MediaInspectionError,
  PlanningIdentityService | ApplicationFilesService | MediaInspectorService
> = compileDocuments

export { RunContractError } from "./errors.js"
export {
  ApplicationFiles,
  ApplicationReadError,
  MediaInspector,
  MediaInspectionError,
  ReferencePlanningError,
  byteMediaInspector,
} from "../reference-planning/index.js"
export type {
  ApplicationFilesService,
  MediaInspectorService,
} from "../reference-planning/index.js"
export { PlanningIdentity } from "./types.js"
export type {
  AssemblyPlan,
  CanonicalRunRequest,
  LinkedRunRelationship,
  PlannedRun,
  PlanningIdentityService,
  RawPlanningDocuments,
  ToolIdentity,
  VideoPlan,
} from "./types.js"
