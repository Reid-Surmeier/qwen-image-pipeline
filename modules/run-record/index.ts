import type { Effect } from "effect"

import type { RunRecordError } from "./errors.js"
import { consumeSubmissionPermit, loadRun, readRunDiagnostics, readRunEvidence, recordOperation, reserveRun } from "./run-record.js"
import type {
  RecordOperation,
  RecordResult,
  ReserveRun,
  RunRecordClockService,
  RunRecordStoreService,
  RunRecordView,
} from "./types.js"

export const reserve: (
  input: ReserveRun,
) => Effect.Effect<RunRecordView, RunRecordError, RunRecordStoreService | RunRecordClockService> = reserveRun

export const record: (
  operation: RecordOperation,
) => Effect.Effect<RecordResult, RunRecordError, RunRecordStoreService | RunRecordClockService> = recordOperation

export const load: (
  runId: string,
) => Effect.Effect<RunRecordView, RunRecordError, RunRecordStoreService> = loadRun

export const readEvidence: (
  runId: string,
  applicationPath: string,
) => Effect.Effect<Uint8Array, RunRecordError, RunRecordStoreService> = readRunEvidence

export const readDiagnostics = readRunDiagnostics

export const consumeSubmission = consumeSubmissionPermit

export { RunRecordError } from "./errors.js"
export { fileRunRecordLayer, makeFileRunRecordHarness } from "./file-store.js"
export type { FileRunRecordFault, FileRunRecordHarness } from "./file-store.js"
export { makeMemoryRunRecordHarness } from "./memory-store.js"
export type { MemoryRunRecordHarness } from "./memory-store.js"
export type { RunRecordErrorCode } from "./errors.js"
export { RunRecordClock } from "./types.js"
export type {
  ProviderEvidenceInput,
  BaselineEvidenceInput,
  GeneratedOutputEvidenceInput,
  AssemblyReportInput,
  FidelityCheckInput,
  RecordOperation,
  RecordResult,
  ReserveRun,
  RunLink,
  RunRecordClockService,
  RunRecordPhase,
  RunRecordStoreService,
  RunRecordView,
  RunRecordDiagnostics,
  SubmissionPermit,
  SubmissionBinding,
} from "./types.js"
