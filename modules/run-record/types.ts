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
