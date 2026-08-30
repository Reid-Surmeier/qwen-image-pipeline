import { Effect } from "effect"

import { RunRecordError } from "./errors.js"
import type {
  RunRecordStoreService,
  StoredRunRecord,
  StoreOperation,
} from "./types.js"

export type MemoryRunRecordStore = Readonly<{
  service: RunRecordStoreService
  submissionCalls: number
  failNext: (operation: StoreOperation) => void
  mutate: (runId: string, mutation: (record: {
    request: Uint8Array
    events: Uint8Array
    state?: Uint8Array
    evidence: Record<string, Uint8Array>
  }) => void) => void
}>

export const makeMemoryRunRecordStore = (): MemoryRunRecordStore => {
  const records = new Map<string, {
    request: Uint8Array
    events: Uint8Array
    state?: Uint8Array
    evidence: Record<string, Uint8Array>
  }>()
  let failing: StoreOperation | undefined

  const check = (operation: StoreOperation): Effect.Effect<void, RunRecordError> => {
    if (failing !== operation) return Effect.void
    failing = undefined
    return Effect.fail(new RunRecordError("DURABILITY_FAILURE", `${operation} was interrupted.`))
  }

  const get = (runId: string) => {
    const record = records.get(runId)
    if (!record) throw new RunRecordError("RUN_NOT_FOUND", `${runId} does not exist.`)
    return record
  }

  const service: RunRecordStoreService = {
    create: (runId, request, firstEvent, state) => check("create").pipe(
      Effect.flatMap(() => {
        if (records.has(runId)) {
          return Effect.fail(new RunRecordError("RUN_ID_CONFLICT", `${runId} already exists.`))
        }
        records.set(runId, {
          request: Uint8Array.from(request),
          events: Uint8Array.from(firstEvent),
          state: Uint8Array.from(state),
          evidence: {},
        })
        return Effect.void
      }),
    ),
    read: (runId) => check("read").pipe(
      Effect.flatMap(() => Effect.try({
        try: () => {
          const value = get(runId)
          return {
            request: Uint8Array.from(value.request),
            events: Uint8Array.from(value.events),
            evidence: Object.fromEntries(
              Object.entries(value.evidence).map(([path, bytes]) => [path, Uint8Array.from(bytes)]),
            ),
            ...(value.state === undefined ? {} : { state: Uint8Array.from(value.state) }),
          } satisfies StoredRunRecord
        },
        catch: (error) => error instanceof RunRecordError
          ? error
          : new RunRecordError("DURABILITY_FAILURE", "Memory Run Record could not be read."),
      })),
    ),
    appendEvent: (runId, expectedHeadSha256, event) => check("append-event").pipe(
      Effect.flatMap(() => Effect.try({
        try: () => {
          const value = get(runId)
          const lines = Buffer.from(value.events).toString("utf8").trimEnd().split("\n")
          const head = JSON.parse(lines.at(-1) ?? "null") as { eventSha256?: unknown } | null
          if (head?.eventSha256 !== expectedHeadSha256) {
            throw new RunRecordError("IDEMPOTENCY_CONFLICT", "The event head changed before append.")
          }
          const combined = new Uint8Array(value.events.length + event.length)
          combined.set(value.events)
          combined.set(event, value.events.length)
          value.events = combined
        },
        catch: (error) => error instanceof RunRecordError
          ? error
          : new RunRecordError("DURABILITY_FAILURE", "Memory event append failed."),
      })),
    ),
    writeEvidence: (runId, applicationPath, body) => check("write-evidence").pipe(
      Effect.flatMap(() => Effect.try({
        try: () => {
          const value = get(runId)
          const existing = value.evidence[applicationPath]
          if (existing !== undefined) {
            if (Buffer.from(existing).equals(Buffer.from(body))) return "same" as const
            throw new RunRecordError("EVIDENCE_REWRITE", `${applicationPath} is write-once.`)
          }
          value.evidence[applicationPath] = Uint8Array.from(body)
          return "created" as const
        },
        catch: (error) => error instanceof RunRecordError
          ? error
          : new RunRecordError("DURABILITY_FAILURE", "Memory evidence could not be written."),
      })),
    ),
    writeState: (runId, state) => check("write-state").pipe(
      Effect.flatMap(() => Effect.sync(() => {
        get(runId).state = Uint8Array.from(state)
      })),
    ),
  }

  return {
    service,
    submissionCalls: 0,
    failNext: (operation) => { failing = operation },
    mutate: (runId, mutation) => mutation(get(runId)),
  }
}
