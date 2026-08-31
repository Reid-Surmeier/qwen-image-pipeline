import type { PlannedRun } from "../run-contract/index.js"
import type { RunRecordDiagnostics } from "../run-record/index.js"
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

export type MachineOutcome =
  | "verified_candidate"
  | "human_decision_required"
  | "blocked"
  | "failed"

export type CorrectionOwner =
  | "Reference Planning"
  | "Generation"
  | "Assembly"
  | "Verification"
  | "application decision owner"

export type OutcomeFinding = Readonly<{
  code: string
  message: string
  correctionOwner: CorrectionOwner
}>

export type PlanDecision =
  | Readonly<{
      _tag: "Planned"
      run: PlannedRun
      normalView: NormalView
    }>
  | Readonly<{
      _tag: "Refused"
      outcome: "blocked" | "failed"
      finding: OutcomeFinding
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
      _tag: "ProviderPending"
      runId: string
      jobId: string
      pollCount: number
      normalView: NormalView
      diagnostics: RunRecordDiagnostics
    }>
  | Readonly<{
      _tag: "HumanDecisionRequired"
      outcome: "human_decision_required"
      finding: OutcomeFinding
      runId: string
      decision: Readonly<{
        kind: "donor-choice"
        candidateSha256s: ReadonlyArray<string>
      }>
      normalView: NormalView
      diagnostics: RunRecordDiagnostics
    }>
  | Readonly<{
      _tag: "Blocked"
      outcome: "blocked"
      runId: string
      finding: OutcomeFinding
      normalView: NormalView
      diagnostics: RunRecordDiagnostics
    }>
  | Readonly<{
      _tag: "Failed"
      outcome: "failed"
      runId: string
      finding: OutcomeFinding
      normalView: NormalView
      diagnostics: RunRecordDiagnostics
    }>
  | Readonly<{
      _tag: "VerifiedCandidate"
      outcome: "verified_candidate"
      runId: string
      candidate: Readonly<{
        applicationPath: `outputs/${string}`
        mediaType: "application/vnd.qwen.rgba+json" | "video/mp4"
        sha256: string
      }>
      normalView: NormalView
      diagnostics: RunRecordDiagnostics
    }>
