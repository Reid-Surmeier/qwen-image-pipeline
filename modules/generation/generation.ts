import { createHash } from "node:crypto"

import { Effect } from "effect"

import type { CanonicalRunRequest } from "../run-contract/index.js"
import type { SubmissionPermit } from "../run-record/index.js"
import { GenerationError } from "./errors.js"
import {
  GenerationAdapter,
  type GenerationAdapterService,
  type GenerationReference,
  type GenerationResult,
  type PreparedGeneration,
} from "./types.js"

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`
}

export const prepareGeneration = (
  request: CanonicalRunRequest,
  references: ReadonlyArray<GenerationReference>,
): Effect.Effect<PreparedGeneration, GenerationError> => Effect.try({
  try: () => {
    if (references.length !== request.references.length) {
      throw new GenerationError("REFERENCE_BYTES_MISMATCH", "Every locked reference must have exact bytes.")
    }
    const inputReferences: Array<Record<string, unknown>> = []
    for (const locked of request.references) {
      const supplied = references.find((candidate) => candidate.slot === locked.slot)
      if (
        supplied === undefined || supplied.applicationPath !== locked.applicationPath ||
        supplied.sha256 !== locked.sha256 || supplied.payloadDestination !== locked.payloadDestination ||
        sha256(supplied.bytes) !== locked.sha256
      ) {
        throw new GenerationError("REFERENCE_BYTES_MISMATCH", `${locked.slot} does not match its locked bytes and SHA-256.`)
      }
      const match = /^\/input_references\/(\d+)\/(image_url|video_url)\/url$/.exec(locked.payloadDestination)
      if (match === null) {
        throw new GenerationError("PAYLOAD_DESTINATION_INVALID", `${locked.payloadDestination} is not a supported exact destination.`)
      }
      const index = Number(match[1])
      if (!Number.isSafeInteger(index) || inputReferences[index] !== undefined) {
        throw new GenerationError("PAYLOAD_DESTINATION_INVALID", "Reference payload destinations must be unique array positions.")
      }
      inputReferences[index] = {
        [match[2]!]: {
          url: {
            applicationPath: supplied.applicationPath,
            bytesBase64: Buffer.from(supplied.bytes).toString("base64"),
            mediaType: supplied.mediaType,
            sha256: supplied.sha256,
          },
        },
      }
    }
    if (inputReferences.some((entry) => entry === undefined)) {
      throw new GenerationError("PAYLOAD_DESTINATION_INVALID", "Reference payload positions must be contiguous.")
    }
    const payload = {
      input_references: inputReferences,
      model: request.model,
      provider: request.provider,
      requested_count: request.requestedCount,
    }
    const payloadBytes = Buffer.from(canonicalize(payload), "utf8")
    return { request, payload, payloadBytes, payloadSha256: sha256(payloadBytes) }
  },
  catch: (error) => error instanceof GenerationError
    ? error
    : new GenerationError("ADAPTER_RESULT_INVALID", "Generation payload preparation failed."),
})

export const invokeGeneration = (
  prepared: PreparedGeneration,
  permit: SubmissionPermit,
): Effect.Effect<GenerationResult, GenerationError | import("../run-record/index.js").RunRecordError, GenerationAdapterService> =>
  Effect.gen(function*() {
    const adapter = yield* GenerationAdapter
    const result = yield* permit.use(Effect.suspend(() => adapter.invoke(prepared)))
    if (result.provider !== prepared.request.provider || result.model !== prepared.request.model) {
      return yield* Effect.fail(new GenerationError("PROVIDER_SUBSTITUTION", "The adapter substituted provider or model."))
    }
    if (result.outputs.length !== prepared.request.requestedCount) {
      return yield* Effect.fail(new GenerationError("OUTPUT_COUNT_MISMATCH", "The adapter returned the wrong output count."))
    }
    if (
      sha256(result.providerEvidence.body) !== result.providerEvidence.sha256 ||
      result.outputs.some((output) =>
        sha256(output.body) !== output.sha256 ||
        !/^outputs\/[a-z0-9][a-z0-9._-]*\.rgba\.json$/.test(output.applicationPath))
    ) {
      return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "Normalized provider or output evidence is invalid."))
    }
    return result
  })
