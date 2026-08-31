import type { NormalView, PlannedRun } from "../run-contract/index.js"
import type { RunRecordState } from "../run-record/index.js"
import type { AssemblyOutput } from "../assembly/index.js"
import type { VerificationReport } from "../verification/index.js"
import type { PlanningRefusal } from "./errors.js"

export const PROJECT_CONTRACT_PATH = ".qwen-pipeline/project-contract.json"
export const TOOL_LOCK_PATH = ".qwen-pipeline/tool-lock.json"

export type { NormalView } from "../run-contract/index.js"

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
  runDirectory: string
  plannedRun?: PlannedRun | undefined
  runId?: string | undefined
  donorChoice?: string | undefined
  requiresHumanApproval?: boolean | undefined
}>

export type AdvanceDecision =
  | Readonly<{
      _tag: "VerifiedCandidate"
      normalView: NormalView
      state: RunRecordState
      verificationReport: VerificationReport
      assemblyOutput?: AssemblyOutput | undefined
    }>
  | Readonly<{
      _tag: "HumanDecisionRequired"
      normalView: NormalView
      state: RunRecordState
      humanDecisionPrompt: string
      verificationReport?: VerificationReport | undefined
    }>
  | Readonly<{
      _tag: "Blocked"
      normalView: NormalView
      state: RunRecordState
      blockReason: string
    }>
  | Readonly<{
      _tag: "Failed"
      normalView: NormalView
      state: RunRecordState
      failureReason: string
      verificationReport?: VerificationReport | undefined
    }>
