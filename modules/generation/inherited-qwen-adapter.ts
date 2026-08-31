import { createHash } from "node:crypto"

import { Effect } from "effect"

import { GenerationError } from "./errors.js"
import type { GenerationAdapterService, GenerationResult, PreparedGeneration } from "./types.js"

export const QWEN_ADAPTER_PROTOCOL_VERSION = "1" as const

export type QwenKernelTransport = Readonly<{
  exchange: (request: Uint8Array) => Effect.Effect<Uint8Array, GenerationError>
}>

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex")

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const decodeBase64 = (value: unknown): Uint8Array | undefined => {
  if (typeof value !== "string") return undefined
  const decoded = Buffer.from(value, "base64")
  return decoded.toString("base64") === value ? decoded : undefined
}

const protocolRequest = (prepared: PreparedGeneration): Uint8Array => {
  const inputReferences = prepared.payload.input_references
  if (!Array.isArray(inputReferences) || inputReferences.length !== prepared.request.references.length) {
    throw new GenerationError("ADAPTER_RESULT_INVALID", "Prepared Qwen references are incomplete.")
  }
  const references = prepared.request.references.map((locked, index) => {
    const input = record(inputReferences[index])
    const image = input === undefined ? undefined : record(input.image_url)
    const url = image === undefined ? undefined : record(image.url)
    if (
      url === undefined ||
      url.applicationPath !== locked.applicationPath ||
      url.sha256 !== locked.sha256 ||
      url.mediaType !== locked.mediaType ||
      typeof url.bytesBase64 !== "string"
    ) {
      throw new GenerationError("ADAPTER_RESULT_INVALID", `Prepared Qwen reference ${locked.slot} changed.`)
    }
    return {
      slot: locked.slot,
      application_path: locked.applicationPath,
      sha256: locked.sha256,
      payload_destination: locked.payloadDestination,
      media_type: locked.mediaType,
      bytes_base64: url.bytesBase64,
    }
  })
  return Buffer.from(JSON.stringify({
    adapter_protocol_version: QWEN_ADAPTER_PROTOCOL_VERSION,
    operation: "invoke",
    provider: prepared.request.provider,
    model: prepared.request.model,
    objective: prepared.request.objective,
    requested_count: prepared.request.requestedCount,
    parameters: prepared.request.imageParameters === undefined
      ? undefined
      : {
          resolution: prepared.request.imageParameters.resolution,
          aspect_ratio: prepared.request.imageParameters.aspectRatio,
          seed: prepared.request.imageParameters.seed,
        },
    references,
  }), "utf8")
}

const protocolResponse = (bytes: Uint8Array): GenerationResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    throw new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen adapter response is not JSON.")
  }
  const response = record(parsed)
  if (
    response === undefined ||
    !exactKeys(response, ["adapter_protocol_version", "provider", "model", "provider_evidence", "outputs"]) ||
    response.adapter_protocol_version !== QWEN_ADAPTER_PROTOCOL_VERSION ||
    response.provider !== "openrouter" ||
    typeof response.model !== "string" ||
    !Array.isArray(response.outputs)
  ) {
    throw new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen adapter response violates protocol version 1.")
  }
  const evidence = record(response.provider_evidence)
  if (evidence === undefined || !exactKeys(evidence, ["media_type", "body_base64", "sha256"])) {
    throw new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen adapter response lacks closed provider evidence.")
  }
  const providerBody = decodeBase64(evidence.body_base64)
  if (
    evidence.media_type !== "application/json" ||
    providerBody === undefined ||
    typeof evidence.sha256 !== "string" ||
    sha256(providerBody) !== evidence.sha256
  ) {
    throw new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen adapter provider evidence changed in transit.")
  }
  const outputs = response.outputs.map((value, index) => {
    const output = record(value)
    if (output === undefined || !exactKeys(output, ["application_path", "media_type", "body_base64", "sha256"])) {
      throw new GenerationError("ADAPTER_RESULT_INVALID", `Qwen adapter output ${index + 1} is not closed.`)
    }
    const body = decodeBase64(output.body_base64)
    if (
      typeof output.application_path !== "string" ||
      output.media_type !== "application/vnd.qwen.rgba+json" ||
      body === undefined ||
      typeof output.sha256 !== "string" ||
      sha256(body) !== output.sha256
    ) {
      throw new GenerationError("ADAPTER_RESULT_INVALID", `Qwen adapter output ${index + 1} changed in transit.`)
    }
    return {
      applicationPath: output.application_path as `outputs/${string}.rgba.json`,
      mediaType: "application/vnd.qwen.rgba+json" as const,
      body,
      sha256: output.sha256,
    }
  })
  return {
    provider: "openrouter",
    model: response.model,
    providerEvidence: {
      mediaType: "application/json",
      body: providerBody,
      sha256: evidence.sha256,
    },
    outputs,
  }
}

export const inheritedQwenAdapter = (
  transport: QwenKernelTransport,
): GenerationAdapterService => ({
  invoke: (prepared) => Effect.gen(function*() {
    const request = yield* Effect.try({
      try: () => protocolRequest(prepared),
      catch: (error) => error instanceof GenerationError
        ? error
        : new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen adapter request could not be encoded."),
    })
    const exchange = yield* Effect.try({
      try: () => transport.exchange(request) as unknown,
      catch: () => new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen transport threw before returning its Effect."),
    })
    if (!Effect.isEffect(exchange)) {
      return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen transport did not return an Effect."))
    }
    const response = yield* (exchange as Effect.Effect<Uint8Array, unknown>).pipe(
      Effect.mapError((error) => error instanceof GenerationError
        ? error
        : new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen transport returned an unnamed error.")),
      Effect.catchDefect(() => Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen transport terminated with a defect."))),
    )
    return yield* Effect.try({
      try: () => protocolResponse(response),
      catch: (error) => error instanceof GenerationError
        ? error
        : new GenerationError("ADAPTER_RESULT_INVALID", "The Qwen adapter response could not be decoded."),
    })
  }),
})
