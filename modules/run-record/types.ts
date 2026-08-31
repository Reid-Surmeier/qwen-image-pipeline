import { Context, type Effect } from "effect"

import type { LinkedRunRelationship, PlannedRun } from "../run-contract/index.js"
import type { RunRecordError } from "./errors.js"

export type RunLink = LinkedRunRelationship

export type ReserveRun = Readonly<{
  plannedRun: PlannedRun
  payloadSha256: string
}>

export type ProviderEvidenceInput = Readonly<{
  mediaType: "application/json"
  body: Uint8Array
  sha256: string
}>

export type GeneratedOutputEvidenceInput = Readonly<{
  applicationPath: `outputs/${string}`
  mediaType: string
  body: Uint8Array
  sha256: string
}>

export type AssemblyReportInput = Readonly<{
  baselineSha256: string
  donorSha256: string
  regionSha256: string
  exactCopySha256: string
  outputSha256: string
}>

export type FidelityCheckInput = Readonly<{
  name: "integrity" | "media" | "outside-region-preservation" | "donor-equality-inside-region"
  passed: boolean
  measured: number
}>

export type BaselineEvidenceInput = Readonly<{
  body: Uint8Array
  sha256: string
}>

export type RecordOperation =
  | Readonly<{
      _tag: "SubmissionMayHaveStarted"
      runId: string
      operationId: string
    }>
  | Readonly<{
      _tag: "CommitProviderEvidence"
      runId: string
      operationId: string
      evidence: ProviderEvidenceInput
    }>
  | Readonly<{
      _tag: "CommitGeneratedOutput"
      runId: string
      operationId: string
      output: GeneratedOutputEvidenceInput
    }>
  | Readonly<{
      _tag: "OpenDonorChoice"
      runId: string
      operationId: string
      candidateSha256s: ReadonlyArray<string>
    }>
  | Readonly<{
      _tag: "SelectDonor"
      runId: string
      operationId: string
      selectedSha256: string
    }>
  | Readonly<{
      _tag: "CommitAssembly"
      runId: string
      operationId: string
      output: GeneratedOutputEvidenceInput
      report: AssemblyReportInput
    }>
  | Readonly<{
      _tag: "CommitChecks"
      runId: string
      operationId: string
      candidateSha256: string
      classification: "verified-candidate"
      baseline: BaselineEvidenceInput
      checks: ReadonlyArray<FidelityCheckInput>
    }>
  | Readonly<{
      _tag: "DefinitivePreSubmitFailure"
      runId: string
      operationId: string
      failure: Readonly<{ class: string; message: string }>
    }>

export type RunRecordPhase =
  | "reserved"
  | "definitive_pre_submit_failure"
  | "submission_may_have_started"
  | "provider_evidence_received"
  | "generated_outputs_received"
  | "awaiting_donor_choice"
  | "donor_selected"
  | "assembly_completed"
  | "verified_candidate"

export type RunRecordView = Readonly<{
  runId: string
  requestSha256: string
  attemptId: string
  payloadSha256: string
  estimatedMaximumCostUsd: string
  maximumCount: number
  maximumSpendUsd: string
  phase: RunRecordPhase
  chainHeadSha256: string
  spendState: "not_spent" | "possibly_spent" | "unknown"
  retryState: "same-run-submission-available" | "new-linked-run-only" | "reconcile-only" | "never-resubmit"
  evidence: ReadonlyArray<Readonly<{
    applicationPath: string
    sha256: string
    byteLength: number
    mediaType: string
  }>>
  donorCandidateSha256s?: ReadonlyArray<string>
  selectedDonorSha256?: string
  assemblyOutputSha256?: string
  assemblyReportSha256?: string
  checksSha256?: string
  classification?: "verified_candidate"
  linkedFrom?: RunLink
}>

export const submissionPermitBrand = Symbol("SubmissionPermit")

export type SubmissionPermit = Readonly<{
  runId: string
  attemptId: string
  use: <Success, Error, Requirements>(
    submission: Effect.Effect<Success, Error, Requirements>,
  ) => Effect.Effect<Success, Error | RunRecordError, Requirements>
  [submissionPermitBrand]: true
}>

export type RecordResult =
  | Readonly<{ _tag: "Recorded"; view: RunRecordView }>
  | Readonly<{ _tag: "SubmissionPermitIssued"; permit: SubmissionPermit; view: RunRecordView }>
  | Readonly<{ _tag: "ReplayObserved"; view: RunRecordView }>

export type StoredRunRecord = Readonly<{
  request: Uint8Array
  events: Uint8Array
  state?: Uint8Array
  evidence: Readonly<Record<string, Uint8Array>>
}>

export type RunRecordDiagnostics = Readonly<{
  request: Uint8Array
  events: Uint8Array
  view: RunRecordView
}>

export type StoreOperation =
  | "create"
  | "read"
  | "append-event"
  | "write-evidence"
  | "write-state"

export interface RunRecordStoreService {
  readonly create: (
    runId: string,
    request: Uint8Array,
    firstEvent: Uint8Array,
    state: Uint8Array,
  ) => Effect.Effect<void, RunRecordError>
  readonly read: (runId: string) => Effect.Effect<StoredRunRecord, RunRecordError>
  readonly appendEvent: (
    runId: string,
    expectedHeadSha256: string,
    event: Uint8Array,
  ) => Effect.Effect<void, RunRecordError>
  readonly writeEvidence: (
    runId: string,
    applicationPath: string,
    body: Uint8Array,
  ) => Effect.Effect<"created" | "same", RunRecordError>
  readonly writeState: (
    runId: string,
    state: Uint8Array,
  ) => Effect.Effect<void, RunRecordError>
}

export const RunRecordStore = Context.Service<RunRecordStoreService>(
  "qwen-pipeline/RunRecordStore",
)

export interface RunRecordClockService {
  readonly now: () => Effect.Effect<string>
}

export const RunRecordClock = Context.Service<RunRecordClockService>(
  "qwen-pipeline/RunRecordClock",
)
