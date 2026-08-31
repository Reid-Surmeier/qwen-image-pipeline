import { createHash } from "node:crypto"
import { Effect } from "effect"

import type { CanonicalRunRequest, NormalView, PlannedRun } from "../run-contract/index.js"
import { RunRecordError } from "./errors.js"
import type {
  AttemptReservation,
  OutputFile,
  PersistedOutput,
  ProviderEvidence,
  RunEvent,
  RunEventType,
  RunRecordState,
  RunRecordStoreService,
  RunStatus,
  SubmissionMarker,
} from "./types.js"

const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex")

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`
}

export const computeEventHash = (
  event: Omit<RunEvent, "hash">,
): string => {
  const canonical = canonicalize({
    sequence: event.sequence,
    timestamp: event.timestamp,
    eventType: event.eventType,
    payload: event.payload,
    prevHash: event.prevHash,
  })
  return sha256(canonical)
}

export const validateEventChain = (
  requestSha256: string,
  events: ReadonlyArray<RunEvent>,
): void => {
  let prevHash = requestSha256
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    if (event.sequence !== i + 1) {
      throw new RunRecordError(
        "BROKEN_EVENT_CHAIN",
        `Event sequence broken at index ${i}: expected ${i + 1}, got ${event.sequence}`,
      )
    }
    if (event.prevHash !== prevHash) {
      throw new RunRecordError(
        "BROKEN_EVENT_CHAIN",
        `Event prevHash mismatch at sequence ${event.sequence}: expected ${prevHash}, got ${event.prevHash}`,
      )
    }
    const expectedHash = computeEventHash(event)
    if (event.hash !== expectedHash) {
      throw new RunRecordError(
        "TAMPERED_RUN_RECORD",
        `Event hash tampering detected at sequence ${event.sequence}: expected ${expectedHash}, got ${event.hash}`,
      )
    }
    prevHash = event.hash
  }
}

export const createMemoryRunRecordStore = (): RunRecordStoreService & {
  readonly getRawState: (runDirectory: string) => RunRecordState | undefined
  readonly tamperEvent: (runDirectory: string, eventIndex: number, newPayload: Record<string, unknown>) => void
  readonly tamperRequest: (runDirectory: string, newRequest: CanonicalRunRequest) => void
} => {
  const runs = new Map<string, {
    state: RunRecordState
    outputFiles: Map<string, Uint8Array>
  }>()

  const getState = (runDirectory: string): RunRecordState => {
    const stored = runs.get(runDirectory)
    if (stored === undefined) {
      throw new RunRecordError("RUN_RECORD_READ_FAILED", `Run record not found at ${runDirectory}`)
    }
    return stored.state
  }

  return {
    getRawState: (dir) => runs.get(dir)?.state,

    tamperEvent: (dir, index, newPayload) => {
      const stored = runs.get(dir)
      if (!stored) return
      const events = [...stored.state.events]
      const old = events[index]
      if (!old) return
      events[index] = { ...old, payload: newPayload }
      stored.state = { ...stored.state, events }
    },

    tamperRequest: (dir, newRequest) => {
      const stored = runs.get(dir)
      if (!stored) return
      stored.state = {
        ...stored.state,
        request: newRequest,
        canonicalRequest: canonicalize(newRequest),
      }
    },

    initRun: (runId, planned, runDirectory) => Effect.sync(() => {
      if (runs.has(runDirectory)) {
        throw new RunRecordError("ILLEGAL_REWRITE", `Run record already exists at ${runDirectory}`, runId)
      }
      const initialEvent: RunEvent = {
        sequence: 1,
        timestamp: new Date().toISOString(),
        eventType: "RUN_PLANNED",
        payload: {
          runId,
          applicationId: planned.request.applicationId,
          objectiveId: planned.request.objectiveId,
          procedureId: planned.request.procedureId,
          mode: planned.request.mode,
          requestSha256: planned.requestSha256,
        },
        prevHash: planned.requestSha256,
        hash: "",
      }
      const hashedInitialEvent: RunEvent = {
        ...initialEvent,
        hash: computeEventHash(initialEvent),
      }

      const state: RunRecordState = {
        runId,
        runDirectory,
        status: "planned",
        request: planned.request,
        canonicalRequest: planned.canonicalRequest,
        requestSha256: planned.requestSha256,
        events: [hashedInitialEvent],
      }
      runs.set(runDirectory, { state, outputFiles: new Map() })
      return state
    }),

    loadRun: (runDirectory) => Effect.sync(() => {
      const stored = runs.get(runDirectory)
      if (stored === undefined) {
        throw new RunRecordError("RUN_RECORD_READ_FAILED", `Run record not found at ${runDirectory}`)
      }
      const state = stored.state
      const computedReqHash = sha256(canonicalize(state.request))
      if (computedReqHash !== state.requestSha256) {
        throw new RunRecordError(
          "TAMPERED_RUN_RECORD",
          `Request hash mismatch: recorded ${state.requestSha256}, computed ${computedReqHash}`,
          state.runId,
        )
      }
      validateEventChain(state.requestSha256, state.events)
      const loadedOutputFiles: Array<PersistedOutput & { bytes: Uint8Array }> = []
      if (state.providerEvidence) {
        for (const out of state.providerEvidence.outputs) {
          const bytes = stored.outputFiles.get(out.name) ?? new Uint8Array()
          loadedOutputFiles.push({ ...out, bytes })
        }
      }
      return {
        ...state,
        outputFiles: state.providerEvidence ? loadedOutputFiles : state.outputFiles,
      }
    }),

    recordAttemptReservation: (runDirectory, attempt) => Effect.sync(() => {
      const stored = runs.get(runDirectory)
      if (stored === undefined) {
        throw new RunRecordError("RUN_RECORD_READ_FAILED", `Run record not found at ${runDirectory}`)
      }
      const state = stored.state
      validateEventChain(state.requestSha256, state.events)

      if (state.attempt !== undefined) {
        if (state.attempt.attemptId !== attempt.attemptId) {
          throw new RunRecordError(
            "ATTEMPT_ALREADY_RESERVED",
            `An attempt was already reserved with id ${state.attempt.attemptId}`,
            state.runId,
          )
        }
        return state
      }

      const prev = state.events[state.events.length - 1]!
      const eventDraft: Omit<RunEvent, "hash"> = {
        sequence: state.events.length + 1,
        timestamp: new Date().toISOString(),
        eventType: "ATTEMPT_RESERVED",
        payload: {
          attemptId: attempt.attemptId,
          payloadDigest: attempt.payloadDigest,
          estimateUsd: attempt.estimateUsd,
          maximumCount: attempt.maximumCount,
          maximumSpendUsd: attempt.maximumSpendUsd,
        },
        prevHash: prev.hash,
      }
      const event: RunEvent = {
        ...eventDraft,
        hash: computeEventHash(eventDraft),
      }

      const newState: RunRecordState = {
        ...state,
        status: "reserved",
        attempt,
        events: [...state.events, event],
      }
      stored.state = newState
      return newState
    }),

    recordSubmissionMayHaveStarted: (runDirectory, marker) => Effect.sync(() => {
      const stored = runs.get(runDirectory)
      if (stored === undefined) {
        throw new RunRecordError("RUN_RECORD_READ_FAILED", `Run record not found at ${runDirectory}`)
      }
      const state = stored.state
      validateEventChain(state.requestSha256, state.events)

      if (state.submissionMarker !== undefined) {
        if (state.submissionMarker.attemptId !== marker.attemptId) {
          throw new RunRecordError(
            "DUPLICATE_SUBMISSION_FORBIDDEN",
            `Submission was already started for attempt ${state.submissionMarker.attemptId}`,
            state.runId,
          )
        }
        return state
      }

      const prev = state.events[state.events.length - 1]!
      const eventDraft: Omit<RunEvent, "hash"> = {
        sequence: state.events.length + 1,
        timestamp: marker.markedAt,
        eventType: "SUBMISSION_STARTED",
        payload: {
          attemptId: marker.attemptId,
          submissionMayHaveStarted: true,
          billingStatus: marker.billingStatus,
        },
        prevHash: prev.hash,
      }
      const event: RunEvent = {
        ...eventDraft,
        hash: computeEventHash(eventDraft),
      }

      const newState: RunRecordState = {
        ...state,
        status: "submission_started",
        submissionMarker: marker,
        events: [...state.events, event],
      }
      stored.state = newState
      return newState
    }),

    recordProviderEvidence: (runDirectory, evidence, outputs) => Effect.sync(() => {
      const stored = runs.get(runDirectory)
      if (stored === undefined) {
        throw new RunRecordError("RUN_RECORD_READ_FAILED", `Run record not found at ${runDirectory}`)
      }
      const state = stored.state
      validateEventChain(state.requestSha256, state.events)

      if (state.providerEvidence !== undefined) {
        throw new RunRecordError(
          "ILLEGAL_REWRITE",
          "Provider evidence is write-once and cannot be overwritten",
          state.runId,
        )
      }

      if (outputs) {
        for (const output of outputs) {
          stored.outputFiles.set(output.name, output.bytes)
        }
      }

      const prev = state.events[state.events.length - 1]!
      const eventDraft: Omit<RunEvent, "hash"> = {
        sequence: state.events.length + 1,
        timestamp: new Date().toISOString(),
        eventType: "PROVIDER_EVIDENCE_RECORDED",
        payload: {
          status: evidence.status,
          bodyDigest: evidence.bodyDigest,
          safeIdentifiers: evidence.safeIdentifiers,
          outputCount: evidence.outputs.length,
          jobId: evidence.jobId,
          costUsd: evidence.costUsd,
        },
        prevHash: prev.hash,
      }
      const event: RunEvent = {
        ...eventDraft,
        hash: computeEventHash(eventDraft),
      }

      const loadedOutputFiles: Array<PersistedOutput & { bytes: Uint8Array }> = []
      if (outputs) {
        for (const out of evidence.outputs) {
          const bytes = stored.outputFiles.get(out.name) ?? new Uint8Array()
          loadedOutputFiles.push({ ...out, bytes })
        }
      }

      const newState: RunRecordState = {
        ...state,
        status: "provider_evidence_received",
        providerEvidence: evidence,
        outputFiles: loadedOutputFiles,
        events: [...state.events, event],
      }
      stored.state = newState
      return newState
    }),

    recordEvent: (runDirectory, eventType, payload) => Effect.sync(() => {
      const stored = runs.get(runDirectory)
      if (stored === undefined) {
        throw new RunRecordError("RUN_RECORD_READ_FAILED", `Run record not found at ${runDirectory}`)
      }
      const state = stored.state
      validateEventChain(state.requestSha256, state.events)

      const prev = state.events[state.events.length - 1]!
      const eventDraft: Omit<RunEvent, "hash"> = {
        sequence: state.events.length + 1,
        timestamp: new Date().toISOString(),
        eventType,
        payload,
        prevHash: prev.hash,
      }
      const event: RunEvent = {
        ...eventDraft,
        hash: computeEventHash(eventDraft),
      }

      let status: RunStatus = state.status
      if (eventType === "DONOR_CHECKPOINT_REACHED") status = "donor_checkpoint"
      else if (eventType === "ASSEMBLY_COMPLETED") status = "assembled"
      else if (eventType === "RUN_COMPLETED") status = "verified"
      else if (eventType === "RUN_FAILED") status = "failed"
      else if (eventType === "RUN_BLOCKED") status = "blocked"

      const newState: RunRecordState = {
        ...state,
        status,
        events: [...state.events, event],
      }
      stored.state = newState
      return newState
    }),

    recordSummary: (runDirectory, normalView, classifiedOutcome) => Effect.sync(() => {
      const stored = runs.get(runDirectory)
      if (stored === undefined) {
        throw new RunRecordError("RUN_RECORD_READ_FAILED", `Run record not found at ${runDirectory}`)
      }
      stored.state = {
        ...stored.state,
        normalView,
        classifiedOutcome,
      }
    }),

    linkPreSubmitFailure: (runDirectory, linkedRunId, reason) => Effect.sync(() => {
      const stored = runs.get(runDirectory)
      if (stored === undefined) {
        throw new RunRecordError("RUN_RECORD_READ_FAILED", `Run record not found at ${runDirectory}`)
      }
      const state = stored.state
      if (state.submissionMarker !== undefined) {
        throw new RunRecordError(
          "PRE_SUBMIT_FAILURE_LINK_REQUIRED",
          "Cannot link pre-submit failure: submission marker already exists",
          state.runId,
        )
      }
      const prev = state.events[state.events.length - 1]!
      const eventDraft: Omit<RunEvent, "hash"> = {
        sequence: state.events.length + 1,
        timestamp: new Date().toISOString(),
        eventType: "RUN_FAILED",
        payload: {
          linkedRunId,
          reason,
          preSubmit: true,
        },
        prevHash: prev.hash,
      }
      const event: RunEvent = {
        ...eventDraft,
        hash: computeEventHash(eventDraft),
      }
      stored.state = {
        ...state,
        status: "failed",
        linkedRunId,
        events: [...state.events, event],
      }
      return linkedRunId
    }),
  }
}
