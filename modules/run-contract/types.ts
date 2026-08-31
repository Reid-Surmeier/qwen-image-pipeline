import { Context } from "effect"

export type ToolIdentity = Readonly<{
  release: string
  commit: string
  artifactSha256: string
  procedureVersion: string
  runSchemaVersion: string
  adapterProtocolVersion: string
}>

export interface PlanningIdentityService {
  readonly installedTool: ToolIdentity
}

export const PlanningIdentity = Context.Service<
  PlanningIdentityService
>("qwen-pipeline/PlanningIdentity")

export type RawPlanningDocuments = Readonly<{
  projectContract: string
  toolLock: string
  objective: string
}>

export type LinkedRunRelationship = Readonly<{
  parentRunId: string
  parentFailureEventSha256: string
  relation: "retry-after-definitive-pre-submit-failure"
}>

export type AssemblyPlan = Readonly<{
  required: true
  baselineReferenceSlot: string
  ownedRegion: Readonly<{
    x: number
    y: number
    width: number
    height: number
  }>
  exactCopy: ReadonlyArray<Readonly<{
    x: number
    y: number
    rgba: readonly [number, number, number, number]
    sha256: string
  }>>
}>

export type CanonicalRunRequest = Readonly<{
  schemaVersion: string
  applicationId: string
  objectiveId: string
  objective: string
  procedureId: string
  mode: "qwen-image" | "seedance-video"
  provider: "openrouter"
  model: string
  adapterProtocolVersion: string
  requestedCount: number
  estimatedMaximumCostUsd: string
  budgetCeilingUsd: string
  outputRoot: string
  linkedRun?: LinkedRunRelationship
  assemblyPlan?: AssemblyPlan
  references: ReadonlyArray<{
    slot: string
    applicationPath: string
    sha256: string
    byteLength: number
    kind: "image" | "video"
    authorityReason: string
    payloadDestination: string
    inspectedMedia: Readonly<{
      width: number
      height: number
      durationSeconds?: number
    }>
  }>
  tool: ToolIdentity
}>

export type PlannedRun = Readonly<{
  state: "planned"
  request: CanonicalRunRequest
  canonicalRequest: string
  requestSha256: string
}>
