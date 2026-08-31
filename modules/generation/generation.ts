import { createHash } from "node:crypto"

import { Effect } from "effect"

import type { CanonicalRunRequest } from "../run-contract/index.js"
import { consumeSubmission, type SubmissionPermit } from "../run-record/index.js"
import { GenerationError } from "./errors.js"
import {
  GenerationAdapter,
  type GenerationAdapterService,
  type GenerationProviderEvidence,
  type GenerationReference,
  type GenerationResult,
  type PreparedGeneration,
  type SeedancePollResult,
  type SeedanceSubmission,
} from "./types.js"

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`
}

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const normalizeAdapterResult = (value: unknown): GenerationResult | undefined => {
  const result = objectRecord(value)
  if (
    result === undefined ||
    typeof result.provider !== "string" ||
    typeof result.model !== "string" || result.model.length === 0
  ) return undefined
  const providerEvidence = objectRecord(result.providerEvidence)
  if (
    providerEvidence === undefined ||
    providerEvidence.mediaType !== "application/json" ||
    !(providerEvidence.body instanceof Uint8Array) ||
    typeof providerEvidence.sha256 !== "string"
  ) return undefined
  if (!Array.isArray(result.outputs)) return undefined
  const outputs: GenerationResult["outputs"][number][] = []
  for (let index = 0; index < result.outputs.length; index += 1) {
    if (!Object.hasOwn(result.outputs, index)) return undefined
    const output = objectRecord(result.outputs[index])
    if (
      output === undefined ||
      typeof output.applicationPath !== "string" ||
      output.mediaType !== "application/vnd.qwen.rgba+json" ||
      !(output.body instanceof Uint8Array) ||
      typeof output.sha256 !== "string"
    ) return undefined
    outputs.push({
      applicationPath: output.applicationPath,
      mediaType: output.mediaType,
      body: output.body,
      sha256: output.sha256,
    })
  }
  return {
    provider: result.provider as GenerationResult["provider"],
    model: result.model,
    providerEvidence: {
      mediaType: providerEvidence.mediaType,
      body: providerEvidence.body,
      sha256: providerEvidence.sha256,
    },
    outputs,
  }
}

const isNormalizedRgbaRaster = (body: Uint8Array): boolean => {
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>
    const { width, height, pixels } = value
    return typeof width === "number" && Number.isSafeInteger(width) && width > 0 &&
      typeof height === "number" && Number.isSafeInteger(height) && height > 0 &&
      Array.isArray(pixels) && pixels.length === width * height * 4 &&
      pixels.every((channel) => typeof channel === "number" && Number.isInteger(channel) && channel >= 0 && channel <= 255)
  } catch {
    return false
  }
}

const isSafeJobId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)

const credentialFieldName = (key: string): boolean => {
  const compatibleKey = key.normalize("NFKC")
  if (/[^\x20-\x7e]/.test(compatibleKey)) return true
  const normalized = compatibleKey.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^x/, "")
  if (["prompttokens", "completiontokens", "totaltokens", "cachedtokens", "reasoningtokens"].includes(normalized)) {
    return false
  }
  return /(?:api|access|private)key$/.test(normalized) ||
    /(?:secret|password|credential)(?:key|value)?$/.test(normalized) ||
    /authorization$/.test(normalized) ||
    /(?:sig|signature)$/.test(normalized) ||
    /credentials?$/.test(normalized) ||
    /^(?:auth|authentication|authorization)(?:data|header|info|token|value)?$/.test(normalized) ||
    /token$/.test(normalized) ||
    /cookie$/.test(normalized) ||
    /^(?:request|response)?headers$/.test(normalized) ||
    normalized === "credential"
}

const stringHasCredentialField = (value: string): boolean => {
  const fields = /"((?:\\.|[^"\\])*)"\s*:/g
  for (const match of value.matchAll(fields)) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`) as unknown
      if (typeof decoded !== "string" || credentialFieldName(decoded)) return true
    } catch {
      return true
    }
  }
  const looseFieldIsCredential = (encoded: string): boolean => {
    if (!encoded.includes("\\")) return credentialFieldName(encoded)
    try {
      const decoded = JSON.parse(`"${encoded}"`) as unknown
      return typeof decoded !== "string" || credentialFieldName(decoded)
    } catch {
      return true
    }
  }
  for (const match of value.matchAll(/'((?:\\.|[^'\\])*)'\s*[:=]/g)) {
    if (looseFieldIsCredential(match[1] ?? "")) return true
  }
  for (const match of value.matchAll(/([\\\p{L}\p{N}_-]+)\s*[:=]/gu)) {
    if (looseFieldIsCredential(match[1] ?? "")) return true
  }
  return false
}

const hasSecretMaterial = (value: unknown, parentKey = "", embeddedDepth = 0): boolean => {
  if (credentialFieldName(parentKey)) {
    return true
  }
  if (typeof value === "string") {
    if (
      /(?:sk-|gh[pousr]_|Bearer\s+)[A-Za-z0-9_-]{6,}/i.test(value) ||
      /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value) ||
      stringHasCredentialField(value) ||
      /"(?:credential|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|password|secret|(?:access|refresh|id)[_-]?token)"\s*:/i.test(value)
    ) return true
    if (/^\s*[\[{]/.test(value)) {
      if (embeddedDepth >= 4) return true
      try {
        if (hasDuplicateJsonKeys(value)) return true
        if (hasSecretMaterial(JSON.parse(value), parentKey, embeddedDepth + 1)) return true
      } catch {
        return true
      }
    }
    return false
  }
  if (Array.isArray(value)) return value.some((child) => hasSecretMaterial(child, parentKey, embeddedDepth))
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => hasSecretMaterial(child, key, embeddedDepth))
  }
  return false
}

const hasDuplicateJsonKeys = (source: string): boolean => {
  let cursor = 0
  const whitespace = () => { while (/\s/.test(source[cursor] ?? "")) cursor += 1 }
  const string = (): string => {
    const start = cursor
    cursor += 1
    while (cursor < source.length) {
      if (source[cursor] === "\\") { cursor += 2; continue }
      if (source[cursor] === '"') {
        cursor += 1
        return JSON.parse(source.slice(start, cursor)) as string
      }
      cursor += 1
    }
    throw new Error("unterminated JSON string")
  }
  const value = (): boolean => {
    whitespace()
    if (source[cursor] === "{") return object()
    if (source[cursor] === "[") return array()
    if (source[cursor] === '"') { string(); return false }
    const start = cursor
    while (cursor < source.length && !/[\s,}\]]/.test(source[cursor]!)) cursor += 1
    if (cursor === start) throw new Error("missing JSON value")
    return false
  }
  const object = (): boolean => {
    cursor += 1
    whitespace()
    const keys = new Set<string>()
    if (source[cursor] === "}") { cursor += 1; return false }
    while (cursor < source.length) {
      whitespace()
      if (source[cursor] !== '"') throw new Error("missing JSON key")
      const key = string()
      if (keys.has(key)) return true
      keys.add(key)
      whitespace()
      if (source[cursor] !== ":") throw new Error("missing JSON colon")
      cursor += 1
      if (value()) return true
      whitespace()
      if (source[cursor] === "}") { cursor += 1; return false }
      if (source[cursor] !== ",") throw new Error("missing JSON object separator")
      cursor += 1
    }
    throw new Error("unterminated JSON object")
  }
  const array = (): boolean => {
    cursor += 1
    whitespace()
    if (source[cursor] === "]") { cursor += 1; return false }
    while (cursor < source.length) {
      if (value()) return true
      whitespace()
      if (source[cursor] === "]") { cursor += 1; return false }
      if (source[cursor] !== ",") throw new Error("missing JSON array separator")
      cursor += 1
    }
    throw new Error("unterminated JSON array")
  }
  try {
    const duplicate = value()
    whitespace()
    return duplicate
  } catch {
    return false
  }
}

const parseProviderDocument = (
  evidence: GenerationProviderEvidence,
): Record<string, unknown> | undefined => {
  if (
    evidence.mediaType !== "application/json" ||
    !(evidence.body instanceof Uint8Array) ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256) ||
    sha256(evidence.body) !== evidence.sha256
  ) return undefined
  try {
    const source = Buffer.from(evidence.body).toString("utf8")
    if (hasDuplicateJsonKeys(source)) return undefined
    const document: unknown = JSON.parse(source)
    if (document === null || typeof document !== "object" || Array.isArray(document) || hasSecretMaterial(document)) {
      return undefined
    }
    return document as Record<string, unknown>
  } catch {
    return undefined
  }
}

type ProviderEvidenceSnapshot = Readonly<{
  mediaType: unknown
  body: unknown
  sha256: unknown
}>

const snapshotProviderEvidence = (value: unknown): ProviderEvidenceSnapshot | undefined => {
  const evidence = objectRecord(value)
  if (evidence === undefined) return undefined
  const { mediaType, body, sha256: digest } = evidence
  return { mediaType, body, sha256: digest }
}

const snapshotSeedanceSubmission = (value: unknown): Readonly<{
  provider: unknown
  model: unknown
  jobId: unknown
  providerEvidence: ProviderEvidenceSnapshot | undefined
}> | undefined => {
  const result = objectRecord(value)
  if (result === undefined) return undefined
  const { provider, model, jobId, providerEvidence } = result
  return { provider, model, jobId, providerEvidence: snapshotProviderEvidence(providerEvidence) }
}

const snapshotSeedancePoll = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  const result = objectRecord(value)
  if (result === undefined) return undefined
  const { status, provider, model, jobId, providerEvidence } = result
  const common = { status, provider, model, jobId, providerEvidence: snapshotProviderEvidence(providerEvidence) }
  if (status !== "completed") return common
  const { outputs: rawOutputs, completedCount, cost: rawCost } = result
  if (!Array.isArray(rawOutputs)) return { ...common, outputs: rawOutputs, completedCount, cost: rawCost }
  const outputCount = rawOutputs.length
  const outputs: unknown[] = []
  for (let index = 0; index < outputCount; index += 1) {
    if (!Object.hasOwn(rawOutputs, index)) return { ...common, outputs: undefined, completedCount, cost: rawCost }
    const output = objectRecord(rawOutputs[index])
    if (output === undefined) { outputs.push(undefined); continue }
    const { applicationPath, mediaType, body, sha256: digest } = output
    outputs.push({ applicationPath, mediaType, body, sha256: digest })
  }
  const cost = objectRecord(rawCost)
  let snapshottedCost: unknown = rawCost
  if (cost !== undefined) {
    const { state, actualCostUsd } = cost
    snapshottedCost = { state, actualCostUsd }
  }
  return { ...common, outputs, completedCount, cost: snapshottedCost }
}

const completedPollMatchesResult = (
  document: Readonly<Record<string, unknown>>,
  outputs: ReadonlyArray<Readonly<{
    applicationPath: string
    mediaType: string
    sha256: string
  }>>,
  completedCount: number,
  cost: Readonly<Record<string, unknown>>,
): boolean => {
  if (
    document.completed_count !== completedCount ||
    !Array.isArray(document.outputs) || document.outputs.length !== outputs.length
  ) return false
  const seen = new Set<string>()
  for (let index = 0; index < document.outputs.length; index += 1) {
    if (!Object.hasOwn(document.outputs, index)) return false
    const receipt = objectRecord(document.outputs[index])
    const output = outputs[index]
    if (
      receipt === undefined || output === undefined ||
      receipt.application_path !== output.applicationPath ||
      receipt.media_type !== output.mediaType || receipt.sha256 !== output.sha256 ||
      seen.has(output.applicationPath)
    ) return false
    seen.add(output.applicationPath)
  }
  const receiptCost = objectRecord(document.cost)
  return receiptCost !== undefined && receiptCost.state === cost.state && (
    cost.state === "actual"
      ? receiptCost.actual_cost_usd === cost.actualCostUsd
      : receiptCost.actual_cost_usd === undefined
  )
}

const adapterEffect = <Success>(
  make: () => unknown,
  missingMessage: string,
): Effect.Effect<Success, GenerationError> => Effect.gen(function*() {
  const untrusted = yield* Effect.try({
    try: make,
    catch: () => new GenerationError("ADAPTER_RESULT_INVALID", `${missingMessage} threw before returning its Effect.`),
  })
  if (!Effect.isEffect(untrusted)) {
    return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", `${missingMessage} did not return an Effect.`))
  }
  return yield* (untrusted as Effect.Effect<Success, unknown>).pipe(
    Effect.mapError((error) => error instanceof GenerationError
      ? error
      : new GenerationError("ADAPTER_RESULT_INVALID", `${missingMessage} failed with an unnamed error.`)),
    Effect.catchDefect(() => Effect.fail(new GenerationError(
      "ADAPTER_RESULT_INVALID",
      `${missingMessage} terminated with a defect.`,
    ))),
  )
})

const referencesFromPreparedPayload = (
  prepared: PreparedGeneration,
): ReadonlyArray<GenerationReference> => {
  const inputReferences = prepared.payload.input_references
  if (
    !Array.isArray(inputReferences) ||
    inputReferences.length !== prepared.request.references.length ||
    Array.from({ length: inputReferences.length }, (_, index) => inputReferences[index])
      .some((entry) => entry === undefined)
  ) {
    throw new GenerationError(
      "ADAPTER_RESULT_INVALID",
      "The prepared provider payload does not contain every locked reference.",
    )
  }
  return prepared.request.references.map((locked) => {
    const match = /^\/input_references\/(\d+)\/(image_url|video_url)\/url$/.exec(locked.payloadDestination)
    const index = match === null ? Number.NaN : Number(match[1])
    const entry = Number.isSafeInteger(index) ? objectRecord(inputReferences[index]) : undefined
    const destination = match === null || entry === undefined
      ? undefined
      : objectRecord(entry[match[2]!])
    const url = destination === undefined ? undefined : objectRecord(destination.url)
    if (
      url === undefined ||
      typeof url.applicationPath !== "string" ||
      typeof url.sha256 !== "string" ||
      typeof url.mediaType !== "string" ||
      typeof url.bytesBase64 !== "string"
    ) {
      throw new GenerationError(
        "ADAPTER_RESULT_INVALID",
        `The prepared provider payload is missing exact evidence for ${locked.slot}.`,
      )
    }
    const bytes = Buffer.from(url.bytesBase64, "base64")
    if (bytes.toString("base64") !== url.bytesBase64) {
      throw new GenerationError(
        "ADAPTER_RESULT_INVALID",
        `The prepared provider payload has invalid encoded evidence for ${locked.slot}.`,
      )
    }
    return {
      slot: locked.slot,
      applicationPath: url.applicationPath,
      sha256: url.sha256,
      payloadDestination: locked.payloadDestination,
      mediaType: url.mediaType as GenerationReference["mediaType"],
      bytes,
    }
  })
}

const validatePreparedGeneration = (
  prepared: PreparedGeneration,
): Effect.Effect<PreparedGeneration, GenerationError> => Effect.gen(function*() {
  const references = yield* Effect.try({
    try: () => referencesFromPreparedPayload(prepared),
    catch: (error) => error instanceof GenerationError
      ? error
      : new GenerationError("ADAPTER_RESULT_INVALID", "The prepared provider payload is malformed."),
  })
  const reconstructed = yield* prepareGeneration(prepared.request, references)
  const matchesReconstruction = yield* Effect.try({
    try: () =>
      prepared.requestSha256 === reconstructed.requestSha256 &&
      prepared.payloadSha256 === reconstructed.payloadSha256 &&
      Buffer.from(prepared.payloadBytes).equals(Buffer.from(reconstructed.payloadBytes)) &&
      canonicalize(prepared.payload) === canonicalize(reconstructed.payload),
    catch: () => new GenerationError(
      "ADAPTER_RESULT_INVALID",
      "The prepared provider payload could not be compared with its reconstruction.",
    ),
  })
  if (!matchesReconstruction) {
    return yield* Effect.fail(new GenerationError(
      "ADAPTER_RESULT_INVALID",
      "The prepared immutable Run or provider payload failed reconstruction from its locked references.",
    ))
  }
  return reconstructed
})

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
        supplied.mediaType !== locked.mediaType || locked.inspectedMedia.mediaType !== locked.mediaType ||
        sha256(supplied.bytes) !== locked.sha256
      ) {
        throw new GenerationError("REFERENCE_BYTES_MISMATCH", `${locked.slot} does not match its locked bytes and SHA-256.`)
      }
      const match = /^\/input_references\/(\d+)\/(image_url|video_url)\/url$/.exec(locked.payloadDestination)
      if (match === null) {
        throw new GenerationError("PAYLOAD_DESTINATION_INVALID", `${locked.payloadDestination} is not a supported exact destination.`)
      }
      const destinationKind = match[2]
      if (
        (destinationKind === "video_url" && supplied.mediaType !== "video/mp4") ||
        (destinationKind === "image_url" && supplied.mediaType !== "image/png" && supplied.mediaType !== "application/vnd.qwen.rgba+json")
      ) {
        throw new GenerationError(
          "PAYLOAD_DESTINATION_INVALID",
          `${locked.payloadDestination} does not accept ${supplied.mediaType} evidence.`,
        )
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
    if (
      inputReferences.length !== references.length ||
      Array.from({ length: inputReferences.length }, (_, index) => inputReferences[index])
        .some((entry) => entry === undefined)
    ) {
      throw new GenerationError("PAYLOAD_DESTINATION_INVALID", "Reference payload positions must be contiguous.")
    }
    const payload = {
      input_references: inputReferences,
      model: request.model,
      provider: request.provider,
      requested_count: request.requestedCount,
    }
    const payloadBytes = Buffer.from(canonicalize(payload), "utf8")
    return {
      request,
      requestSha256: sha256(canonicalize(request)),
      payload,
      payloadBytes,
      payloadSha256: sha256(payloadBytes),
    }
  },
  catch: (error) => error instanceof GenerationError
    ? error
    : new GenerationError("ADAPTER_RESULT_INVALID", "Generation payload preparation failed."),
})

const validateGenerationResult = (
  prepared: PreparedGeneration,
  untrustedResult: unknown,
  expectedProviderEvidence?: GenerationProviderEvidence,
): Effect.Effect<GenerationResult, GenerationError> => Effect.gen(function*() {
  const result = yield* Effect.try({
    try: () => normalizeAdapterResult(untrustedResult),
    catch: () => new GenerationError("ADAPTER_RESULT_INVALID", "The adapter returned a malformed result."),
  })
  if (result === undefined) {
    return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "The adapter returned a malformed result."))
  }
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
      !isNormalizedRgbaRaster(output.body) ||
      !/^outputs\/[a-z0-9][a-z0-9._-]*\.rgba\.json$/.test(output.applicationPath))
  ) {
    return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "Normalized provider or output evidence is invalid."))
  }
  if (
    expectedProviderEvidence !== undefined &&
    (
      result.providerEvidence.mediaType !== expectedProviderEvidence.mediaType ||
      result.providerEvidence.sha256 !== expectedProviderEvidence.sha256 ||
      !Buffer.from(result.providerEvidence.body).equals(Buffer.from(expectedProviderEvidence.body))
    )
  ) {
    return yield* Effect.fail(new GenerationError(
      "ADAPTER_RESULT_INVALID",
      "Recovered Generation evidence substituted the persisted provider response.",
    ))
  }
  return result
})

export const invokeGeneration = (
  prepared: PreparedGeneration,
  permit: SubmissionPermit,
): Effect.Effect<GenerationResult, GenerationError | import("../run-record/index.js").RunRecordError, GenerationAdapterService> =>
  Effect.gen(function*() {
    const validatedPrepared = yield* validatePreparedGeneration(prepared)
    const adapter = yield* GenerationAdapter
    const submission = Effect.gen(function*() {
      const adapterEffect: unknown = yield* Effect.try({
        try: () => adapter.invoke(validatedPrepared) as unknown,
        catch: () => new GenerationError("ADAPTER_RESULT_INVALID", "The adapter threw before returning its Effect."),
      })
      if (!Effect.isEffect(adapterEffect)) {
        return yield* Effect.fail(new GenerationError(
          "ADAPTER_RESULT_INVALID",
          "The adapter did not return an Effect.",
        ))
      }
      return yield* adapterEffect.pipe(
        Effect.mapError((error) => error instanceof GenerationError
          ? error
          : new GenerationError("ADAPTER_RESULT_INVALID", "The adapter Effect failed with an unnamed error.")),
        Effect.catchDefect(() => Effect.fail(new GenerationError(
          "ADAPTER_RESULT_INVALID",
          "The adapter Effect terminated with a defect.",
        ))),
      )
    })
    yield* consumeSubmission(permit, {
      requestSha256: validatedPrepared.requestSha256,
      payloadSha256: validatedPrepared.payloadSha256,
    })
    const untrustedResult: unknown = yield* submission
    return yield* validateGenerationResult(validatedPrepared, untrustedResult)
  })

export const recoverGeneration = (
  prepared: PreparedGeneration,
  providerEvidence: GenerationProviderEvidence,
): Effect.Effect<GenerationResult, GenerationError, GenerationAdapterService> => Effect.gen(function*() {
  const validatedPrepared = yield* validatePreparedGeneration(prepared)
  if (
    providerEvidence.mediaType !== "application/json" ||
    !/^[a-f0-9]{64}$/.test(providerEvidence.sha256) ||
    sha256(providerEvidence.body) !== providerEvidence.sha256
  ) {
    return yield* Effect.fail(new GenerationError(
      "ADAPTER_RESULT_INVALID",
      "Recovery requires the exact persisted provider response evidence.",
    ))
  }
  const adapter = yield* GenerationAdapter
  if (typeof adapter.recover !== "function") {
    return yield* Effect.fail(new GenerationError(
      "ADAPTER_RESULT_INVALID",
      "The adapter cannot recover outputs from persisted provider evidence.",
    ))
  }
  const adapterEffect: unknown = yield* Effect.try({
    try: () => adapter.recover!(validatedPrepared, providerEvidence) as unknown,
    catch: () => new GenerationError("ADAPTER_RESULT_INVALID", "The recovery adapter threw before returning its Effect."),
  })
  if (!Effect.isEffect(adapterEffect)) {
    return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "The recovery adapter did not return an Effect."))
  }
  const untrustedResult: unknown = yield* adapterEffect.pipe(
    Effect.mapError((error) => error instanceof GenerationError
      ? error
      : new GenerationError("ADAPTER_RESULT_INVALID", "The recovery adapter failed with an unnamed error.")),
    Effect.catchDefect(() => Effect.fail(new GenerationError(
      "ADAPTER_RESULT_INVALID",
      "The recovery adapter terminated with a defect.",
    ))),
  )
  return yield* validateGenerationResult(validatedPrepared, untrustedResult, providerEvidence)
})

export const submitSeedanceGeneration = (
  prepared: PreparedGeneration,
  permit: SubmissionPermit,
): Effect.Effect<SeedanceSubmission, GenerationError | import("../run-record/index.js").RunRecordError, GenerationAdapterService> =>
  Effect.gen(function*() {
    const validatedPrepared = yield* validatePreparedGeneration(prepared)
    if (
      validatedPrepared.request.mode !== "seedance-video" ||
      validatedPrepared.request.videoPlan?.assembly.required !== false ||
      validatedPrepared.request.videoPlan.assembly.pixelOwnership !== "none-authoritative" ||
      validatedPrepared.request.references.some((reference) =>
        reference.kind !== "video" || reference.mediaType !== "video/mp4" ||
        !/\/video_url\/url$/.test(reference.payloadDestination))
    ) {
      return yield* Effect.fail(new GenerationError(
        "ADAPTER_RESULT_INVALID",
        "Seedance submission requires an immutable exact-video plan with an explicit no-Assembly proof.",
      ))
    }
    const adapter = yield* GenerationAdapter
    if (typeof adapter.submitSeedance !== "function") {
      return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "The adapter cannot submit Seedance."))
    }
    yield* consumeSubmission(permit, {
      requestSha256: validatedPrepared.requestSha256,
      payloadSha256: validatedPrepared.payloadSha256,
    })
    const untrusted = yield* adapterEffect<unknown>(
      () => adapter.submitSeedance!(validatedPrepared),
      "The Seedance submission adapter",
    )
    const result = yield* Effect.try({
      try: () => snapshotSeedanceSubmission(untrusted),
      catch: () => new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance submission result could not be snapshotted safely."),
    })
    const evidenceRecord = result?.providerEvidence
    const providerEvidence: GenerationProviderEvidence | undefined = evidenceRecord === undefined ||
        evidenceRecord.mediaType !== "application/json" ||
        !(evidenceRecord.body instanceof Uint8Array) ||
        typeof evidenceRecord.sha256 !== "string"
      ? undefined
      : {
          mediaType: "application/json",
          body: evidenceRecord.body,
          sha256: evidenceRecord.sha256,
        }
    const document = providerEvidence === undefined ? undefined : parseProviderDocument(providerEvidence)
    if (
      result === undefined || result.provider !== validatedPrepared.request.provider ||
      result.model !== validatedPrepared.request.model || !isSafeJobId(result.jobId) ||
      providerEvidence === undefined || document?.job_id !== result.jobId ||
      (document.status !== "submitted" && document.status !== "queued")
    ) {
      return yield* Effect.fail(new GenerationError(
        "ADAPTER_RESULT_INVALID",
        "Seedance submission did not return a sanitized response bound to one job identity.",
      ))
    }
    return {
      provider: "openrouter" as const,
      model: validatedPrepared.request.model,
      jobId: result.jobId,
      providerEvidence,
    }
  }).pipe(Effect.catchDefect(() => Effect.fail(new GenerationError(
    "ADAPTER_RESULT_INVALID",
    "The Seedance submission result could not be inspected safely.",
  ))))

export const pollSeedanceGeneration = (
  prepared: PreparedGeneration,
  jobId: string,
  submissionEvidence: GenerationProviderEvidence,
): Effect.Effect<SeedancePollResult, GenerationError, GenerationAdapterService> =>
  Effect.gen(function*() {
    const validatedPrepared = yield* validatePreparedGeneration(prepared)
    const submissionDocument = parseProviderDocument(submissionEvidence)
    if (
      validatedPrepared.request.mode !== "seedance-video" ||
      !isSafeJobId(jobId) || submissionDocument?.job_id !== jobId ||
      (submissionDocument.status !== "submitted" && submissionDocument.status !== "queued")
    ) {
      return yield* Effect.fail(new GenerationError(
        "ADAPTER_RESULT_INVALID",
        "Seedance polling requires the exact sanitized submission receipt and job identity.",
      ))
    }
    const adapter = yield* GenerationAdapter
    if (typeof adapter.pollSeedance !== "function") {
      return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "The adapter cannot poll Seedance."))
    }
    const untrusted = yield* adapterEffect<unknown>(
      () => adapter.pollSeedance!(validatedPrepared, jobId, submissionEvidence),
      "The Seedance polling adapter",
    )
    const result = yield* Effect.try({
      try: () => snapshotSeedancePoll(untrusted),
      catch: () => new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance poll result could not be snapshotted safely."),
    })
    const evidenceRecord = result === undefined ? undefined : objectRecord(result.providerEvidence)
    const providerEvidence: GenerationProviderEvidence | undefined = evidenceRecord === undefined ||
        evidenceRecord.mediaType !== "application/json" ||
        !(evidenceRecord.body instanceof Uint8Array) ||
        typeof evidenceRecord.sha256 !== "string"
      ? undefined
      : {
          mediaType: "application/json",
          body: evidenceRecord.body,
          sha256: evidenceRecord.sha256,
        }
    const document = providerEvidence === undefined ? undefined : parseProviderDocument(providerEvidence)
    if (
      result === undefined || result.provider !== validatedPrepared.request.provider ||
      result.model !== validatedPrepared.request.model || result.jobId !== jobId ||
      providerEvidence === undefined || document?.job_id !== jobId ||
      (result.status !== "pending" && result.status !== "completed") ||
      document.status !== result.status
    ) {
      return yield* Effect.fail(new GenerationError(
        "ADAPTER_RESULT_INVALID",
        "Seedance poll evidence substituted the provider, model, job identity, or status.",
      ))
    }
    if (result.status === "pending") {
      return {
        status: "pending" as const,
        provider: "openrouter" as const,
        model: validatedPrepared.request.model,
        jobId,
        providerEvidence,
      }
    }
    if (
      !Array.isArray(result.outputs) ||
      typeof result.completedCount !== "number" || !Number.isSafeInteger(result.completedCount) ||
      result.completedCount !== validatedPrepared.request.requestedCount ||
      result.outputs.length !== result.completedCount
    ) {
      return yield* Effect.fail(new GenerationError("OUTPUT_COUNT_MISMATCH", "Seedance completed with the wrong output count."))
    }
    const outputs: Extract<SeedancePollResult, { status: "completed" }>["outputs"][number][] = []
    const paths = new Set<string>()
    for (let index = 0; index < result.outputs.length; index += 1) {
      if (!Object.hasOwn(result.outputs, index)) {
        return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "Seedance returned a sparse output set."))
      }
      const output = objectRecord(result.outputs[index])
      if (
        output === undefined || typeof output.applicationPath !== "string" ||
        !/^outputs\/[a-z0-9][a-z0-9._-]*\.mp4$/.test(output.applicationPath) ||
        paths.has(output.applicationPath) || output.mediaType !== "video/mp4" ||
        !(output.body instanceof Uint8Array) || typeof output.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(output.sha256) || sha256(output.body) !== output.sha256
      ) {
        return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "Seedance output evidence is malformed."))
      }
      paths.add(output.applicationPath)
      outputs.push({
        applicationPath: output.applicationPath as `outputs/${string}.mp4`,
        mediaType: "video/mp4",
        body: output.body,
        sha256: output.sha256,
      })
    }
    const cost = objectRecord(result.cost)
    if (
      cost === undefined ||
      (cost.state !== "actual" && cost.state !== "estimated-only" && cost.state !== "unknown") ||
      (cost.state === "actual"
        ? typeof cost.actualCostUsd !== "string" || !/^(?:0|[1-9]\d*)\.\d{2,6}$/.test(cost.actualCostUsd)
        : cost.actualCostUsd !== undefined)
    ) {
      return yield* Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "Seedance cost evidence is malformed."))
    }
    if (!completedPollMatchesResult(document, outputs, result.completedCount, cost)) {
      return yield* Effect.fail(new GenerationError(
        "ADAPTER_RESULT_INVALID",
        "The sanitized Seedance completion receipt does not bind the exact outputs, count, and cost.",
      ))
    }
    return {
      status: "completed" as const,
      provider: "openrouter" as const,
      model: validatedPrepared.request.model,
      jobId,
      providerEvidence,
      outputs,
      completedCount: result.completedCount,
      cost: cost.state === "actual"
        ? { state: "actual" as const, actualCostUsd: cost.actualCostUsd as string }
        : { state: cost.state as "estimated-only" | "unknown" },
    }
  }).pipe(Effect.catchDefect(() => Effect.fail(new GenerationError(
    "ADAPTER_RESULT_INVALID",
    "The Seedance poll result could not be inspected safely.",
  ))))
