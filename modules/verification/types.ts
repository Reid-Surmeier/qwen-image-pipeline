import { Context, type Effect } from "effect"

import type { RunRecordState } from "../run-record/index.js"
import type { AssemblyOutput } from "../assembly/index.js"
import type { VerificationError } from "./errors.js"

export type VerificationStage =
  | "INTEGRITY"
  | "MEDIA_AND_COUNT"
  | "ASSEMBLY_FIDELITY"
  | "TASK_DETERMINISTIC"
  | "SEMANTIC_REVIEW"
  | "OWNER_APPROVAL"

export type StageResult = Readonly<{
  stage: VerificationStage
  passed: boolean
  message: string
  details?: Readonly<Record<string, unknown>> | undefined
}>

export type VerificationOutcome =
  | "verified_candidate"
  | "human_decision_required"
  | "blocked"
  | "failed"

export type VerificationReport = Readonly<{
  outcome: VerificationOutcome
  passed: boolean
  stages: ReadonlyArray<StageResult>
  failureReason?: string | undefined
  humanDecisionPrompt?: string | undefined
}>

export type VerificationInput = Readonly<{
  state: RunRecordState
  outputFiles: ReadonlyArray<{
    name: string
    bytes: Uint8Array
    sha256: string
    mediaType: string
  }>
  assemblyOutput?: AssemblyOutput | undefined
  requiresHumanApproval?: boolean | undefined
}>

export interface VerificationService {
  readonly verify: (
    input: VerificationInput,
  ) => Effect.Effect<VerificationReport, VerificationError>
}

export const Verification = Context.Service<
  VerificationService
>("qwen-pipeline/Verification")
