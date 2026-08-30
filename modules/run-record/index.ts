import type { Effect } from "effect"

import type { RunRecordError } from "./errors.js"
import { loadRun, recordOperation, reserveRun } from "./run-record.js"
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

export { RunRecordError } from "./errors.js"
export { makeFileRunRecordStore } from "./file-store.js"
export { makeMemoryRunRecordStore } from "./memory-store.js"
export type { RunRecordErrorCode } from "./errors.js"
export { RunRecordClock, RunRecordStore } from "./types.js"
export type {
  ProviderEvidenceInput,
  RecordOperation,
  RecordResult,
  ReserveRun,
  RunLink,
  RunRecordClockService,
  RunRecordPhase,
  RunRecordStoreService,
  RunRecordView,
  StoreOperation,
  SubmissionPermit,
} from "./types.js"
