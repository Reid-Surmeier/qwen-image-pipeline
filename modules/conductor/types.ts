import type { PlannedRun } from "../run-contract/index.js"
import type { RunRecordView } from "../run-record/index.js"
import type { PlanningRefusal } from "./errors.js"

export const PROJECT_CONTRACT_PATH = ".qwen-pipeline/project-contract.json"
export const TOOL_LOCK_PATH = ".qwen-pipeline/tool-lock.json"

export type NormalView = Readonly<{
  objective: string
  evidence: string
  nextAction: string
  spendRisk: string
  humanDecision: string
}>

export type PlanDecision =
  | Readonly<{
      _tag: "Planned"
      run: PlannedRun
      normalView: NormalView
    }>
  | Readonly<{
      _tag: "Refused"
      refusal: PlanningRefusal
      normalView: NormalView
    }>

export type PlanCommand = Readonly<{
  objectivePath: string
}>

export type AdvanceCommand = Readonly<{
  run: PlannedRun
  selectedDonorSha256?: string
}>

export type AdvanceDecision =
  | Readonly<{
      _tag: "HumanDecisionRequired"
      runId: string
      decision: Readonly<{
        kind: "donor-choice"
        candidateSha256s: ReadonlyArray<string>
      }>
      normalView: NormalView
      diagnostics: RunRecordView
    }>
  | Readonly<{
      _tag: "VerifiedCandidate"
      runId: string
      candidate: Readonly<{
        applicationPath: "outputs/assembled.rgba.json"
        sha256: string
      }>
      normalView: NormalView
      diagnostics: RunRecordView
    }>
