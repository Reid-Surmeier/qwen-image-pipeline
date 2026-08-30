import type { Effect } from "effect"

import type {
  ApplicationFilesService,
  MediaInspectorService,
  PlanningIdentityService,
} from "../run-contract/index.js"
import { planObjective } from "./conductor.js"
import type { PlanCommand, PlanDecision } from "./types.js"

export const plan: (
  command: PlanCommand,
) => Effect.Effect<
  PlanDecision,
  never,
  ApplicationFilesService | MediaInspectorService | PlanningIdentityService
> = planObjective

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
  NormalView,
  PlanCommand,
  PlanDecision,
} from "./types.js"
