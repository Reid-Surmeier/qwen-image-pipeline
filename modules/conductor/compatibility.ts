import { Effect } from "effect"

import type {
  ApplicationFilesService,
  MediaInspectorService,
  PlanningIdentityService,
} from "../run-contract/index.js"
import type { GenerationAdapterService } from "../generation/index.js"
import type { RunRecordClockService, RunRecordStoreService } from "../run-record/index.js"
import type { ConductorError } from "./errors.js"
import { advanceRun, planObjective } from "./conductor.js"
import type { AdvanceCommand, AdvanceDecision, PlanCommand, PlanDecision } from "./types.js"

export type CompatibilitySurface =
  | "python-cli.generate"
  | "comfyui.QwenImage3TextToImage"
  | "comfyui.QwenImage3Edit"
  | "comfyui.QwenImage3Render"

export type CompatibilityMetadata = Readonly<{
  schemaVersion: "1"
  adapterProtocolVersion: "1"
  status: "deprecated"
  surface: CompatibilitySurface
  replacement: "Conductor.plan" | "Conductor.advance"
  retirementCondition: string
}>

export type CompatibilityResult<Decision> = Readonly<{
  compatibility: CompatibilityMetadata
  decision: Decision
}>

const RETIREMENT_CONDITIONS: Readonly<Record<CompatibilitySurface, string>> = Object.freeze({
  "python-cli.generate": "Issue #28 migrates the Python CLI caller and proves saved-input compatibility.",
  "comfyui.QwenImage3TextToImage": "Issue #29 migrates the ComfyUI node and proves saved-workflow compatibility.",
  "comfyui.QwenImage3Edit": "Issue #29 migrates the ComfyUI node and proves saved-workflow compatibility.",
  "comfyui.QwenImage3Render": "Issue #29 migrates the ComfyUI node and proves saved-workflow compatibility.",
})

const metadata = (
  surface: CompatibilitySurface,
  replacement: CompatibilityMetadata["replacement"],
): CompatibilityMetadata => Object.freeze({
  schemaVersion: "1",
  adapterProtocolVersion: "1",
  status: "deprecated",
  surface,
  replacement,
  retirementCondition: RETIREMENT_CONDITIONS[surface],
})

const result = <Decision>(
  compatibility: CompatibilityMetadata,
  decision: Decision,
): CompatibilityResult<Decision> => Object.freeze({ compatibility, decision })

export const compatibilityPlan = (
  surface: CompatibilitySurface,
  command: PlanCommand,
): Effect.Effect<
  CompatibilityResult<PlanDecision>,
  never,
  ApplicationFilesService | MediaInspectorService | PlanningIdentityService
> => planObjective(command).pipe(
  Effect.map((decision) => result(metadata(surface, "Conductor.plan"), decision)),
)

export const compatibilityAdvance = (
  surface: CompatibilitySurface,
  command: AdvanceCommand,
): Effect.Effect<
  CompatibilityResult<AdvanceDecision>,
  ConductorError,
  ApplicationFilesService | PlanningIdentityService | GenerationAdapterService | RunRecordStoreService | RunRecordClockService
> => advanceRun(command).pipe(
  Effect.map((decision) => result(metadata(surface, "Conductor.advance"), decision)),
)
