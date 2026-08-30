import type { PlannedRun } from "../run-contract/index.js"
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
