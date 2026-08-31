import { Context, type Effect } from "effect"

import type { CanonicalRunRequest, NormalView, PlannedRun } from "../run-contract/index.js"
import type { RunRecordError } from "./errors.js"

export type RunEventType =
  | "RUN_PLANNED"
  | "ATTEMPT_RESERVED"
  | "SUBMISSION_STARTED"
  | "PROVIDER_EVIDENCE_RECORDED"
  | "DONOR_CHECKPOINT_REACHED"
  | "DONOR_SELECTED"
  | "ASSEMBLY_COMPLETED"
  | "CHECK_PASSED"
  | "CHECK_FAILED"
  | "RUN_COMPLETED"
  | "RUN_BLOCKED"
  | "RUN_FAILED"

export type RunEvent = Readonly<{
  sequence: number
  timestamp: string
  eventType: RunEventType | string
  payload: Readonly<Record<string, unknown>>
  prevHash: string
  hash: string
}>

export type AttemptReservation = Readonly<{
  attemptId: string
  runId: string
  requestSha256: string
  payloadDigest: string
  estimateUsd: string
  maximumCount: number
  maximumSpendUsd: string
  retryAllowed: false
  billingStatus: "reserved" | "possibly_spent" | "reconciled"
}>

export type SubmissionMarker = Readonly<{
  attemptId: string
  markedAt: string
  submissionMayHaveStarted: true
  billingStatus: "possibly_spent"
}>

export type PersistedOutput = Readonly<{
  name: string
  sha256: string
  byteLength: number
  mediaType: string
}>

export type ProviderEvidence = Readonly<{
  status: number
  bodyDigest: string
  sanitizedBody?: Readonly<Record<string, unknown>> | undefined
  safeIdentifiers: ReadonlyArray<string>
  outputs: ReadonlyArray<PersistedOutput>
  usage?: Readonly<Record<string, unknown>> | undefined
  costUsd?: string | undefined
  jobId?: string | undefined
}>

export type RunStatus =
  | "planned"
  | "reserved"
  | "submission_started"
  | "provider_evidence_received"
  | "donor_checkpoint"
  | "assembled"
  | "verified"
  | "failed"
  | "blocked"

export type RunRecordState = Readonly<{
  runId: string
  runDirectory: string
  status: RunStatus
  request: CanonicalRunRequest
  canonicalRequest: string
  requestSha256: string
  events: ReadonlyArray<RunEvent>
  attempt?: AttemptReservation | undefined
  submissionMarker?: SubmissionMarker | undefined
  providerEvidence?: ProviderEvidence | undefined
  outputFiles?: ReadonlyArray<PersistedOutput & { bytes: Uint8Array }> | undefined
  linkedRunId?: string | undefined
  classifiedOutcome?: string | undefined
  normalView?: NormalView | undefined
}>

export interface OutputFile {
  readonly name: string
  readonly bytes: Uint8Array
}

export interface RunRecordStoreService {
  readonly initRun: (
    runId: string,
    planned: PlannedRun,
    runDirectory: string,
  ) => Effect.Effect<RunRecordState, RunRecordError>

  readonly loadRun: (
    runDirectory: string,
  ) => Effect.Effect<RunRecordState, RunRecordError>

  readonly recordAttemptReservation: (
    runDirectory: string,
    attempt: AttemptReservation,
  ) => Effect.Effect<RunRecordState, RunRecordError>

  readonly recordSubmissionMayHaveStarted: (
    runDirectory: string,
    marker: SubmissionMarker,
  ) => Effect.Effect<RunRecordState, RunRecordError>

  readonly recordProviderEvidence: (
    runDirectory: string,
    evidence: ProviderEvidence,
    outputs?: ReadonlyArray<OutputFile>,
  ) => Effect.Effect<RunRecordState, RunRecordError>

  readonly recordEvent: (
    runDirectory: string,
    eventType: RunEventType | string,
    payload: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<RunRecordState, RunRecordError>

  readonly recordSummary: (
    runDirectory: string,
    normalView: NormalView,
    classifiedOutcome: string,
  ) => Effect.Effect<void, RunRecordError>

  readonly linkPreSubmitFailure: (
    runDirectory: string,
    linkedRunId: string,
    reason: string,
  ) => Effect.Effect<string, RunRecordError>
}

export const RunRecordStore = Context.Service<
  RunRecordStoreService
>("qwen-pipeline/RunRecordStore")
