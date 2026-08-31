import type { Effect } from "effect"

import type {
  ApplicationFilesService,
  MediaInspectorService,
  PlanningIdentityService,
} from "../run-contract/index.js"
import type { RunRecordStoreService } from "../run-record/index.js"
import type { GenerationAdapterService } from "../generation/index.js"
import type { AssemblyService } from "../assembly/index.js"
import type { VerificationService } from "../verification/index.js"
import { advanceRun, planObjective } from "./conductor.js"
import type {
  AdvanceCommand,
  AdvanceDecision,
  PlanCommand,
  PlanDecision,
} from "./types.js"

export const plan: (
  command: PlanCommand,
) => Effect.Effect<
  PlanDecision,
  never,
  ApplicationFilesService | MediaInspectorService | PlanningIdentityService
> = planObjective

export const advance: (
  command: AdvanceCommand,
) => Effect.Effect<
  AdvanceDecision,
  never,
  | RunRecordStoreService
  | GenerationAdapterService
  | AssemblyService
  | VerificationService
  | ApplicationFilesService
> = advanceRun

export type { PlanningRefusal, PlanningRefusalCode } from "./errors.js"
export {
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
} from "../run-contract/index.js"
export type {
  ApplicationFilesService,
  MediaInspectorService,
  PlanningIdentityService,
} from "../run-contract/index.js"
export { ApplicationReadError } from "../run-contract/index.js"
export {
  PROJECT_CONTRACT_PATH,
  TOOL_LOCK_PATH,
} from "./types.js"
export type {
  AdvanceCommand,
  AdvanceDecision,
  NormalView,
  PlanCommand,
  PlanDecision,
} from "./types.js"
