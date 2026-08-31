import type { Effect } from "effect"

import type {
  ApplicationFilesService,
  MediaInspectorService,
  PlanningIdentityService,
} from "../run-contract/index.js"
import type { GenerationAdapterService } from "../generation/index.js"
import type { RunRecordClockService, RunRecordStoreService } from "../run-record/index.js"
import { advanceRun, planObjective } from "./conductor.js"
import type { AdvanceCommand, AdvanceDecision, PlanCommand, PlanDecision } from "./types.js"
import type { ConductorError } from "./errors.js"

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
  ConductorError,
  ApplicationFilesService | PlanningIdentityService | GenerationAdapterService | RunRecordStoreService | RunRecordClockService
> = advanceRun

export { ConductorError } from "./errors.js"
export type { ConductorErrorCode, PlanningRefusal, PlanningRefusalCode } from "./errors.js"
export {
  ApplicationFiles,
  fileApplicationFiles,
  filePlanningIdentity,
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
  CorrectionOwner,
  MachineOutcome,
  NormalView,
  OutcomeFinding,
  PlanCommand,
  PlanDecision,
} from "./types.js"
