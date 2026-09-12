import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { Effect } from "effect"

import { GenerationError, type GenerationAdapterService, type GenerationProviderEvidence, type PreparedGeneration, type SeedancePollResult, type SeedanceSubmission } from "../modules/generation/index.js"

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex")
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const evidence = (value: unknown): GenerationProviderEvidence => {
  const item = record(value)
  if (item === undefined || !exactKeys(item, ["media_type", "body_base64", "sha256"]) ||
      item.media_type !== "application/json" || typeof item.body_base64 !== "string" || typeof item.sha256 !== "string") {
    throw new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance host returned malformed provider evidence.")
  }
  const body = Buffer.from(item.body_base64, "base64")
  if (body.toString("base64") !== item.body_base64 || sha256(body) !== item.sha256) {
    throw new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance host provider evidence changed in transit.")
  }
  return { mediaType: "application/json", body, sha256: item.sha256 }
}

const exchange = (toolRoot: string, document: Record<string, unknown>): Record<string, unknown> => {
  const result = spawnSync("/usr/bin/python3", ["-m", "seedance_icons.adapter_host"], {
    input: JSON.stringify(document),
    env: {
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      PATH: "/usr/bin:/bin",
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      PYTHONPATH: `${toolRoot}/seedance/src`,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120_000,
  })
  let decoded: unknown
  try { decoded = JSON.parse(result.stdout) } catch { decoded = undefined }
  const response = record(decoded)
  if (result.status !== 0) {
    const failure = record(response?.adapter_error)
    const code = failure?.code
    if (exactKeys(failure ?? {}, ["code", "message"]) &&
        (code === "ADAPTER_NOT_STARTED" || code === "ADAPTER_RESULT_INVALID" || code === "PROVIDER_AMBIGUOUS")) {
      throw new GenerationError(code, "The Seedance Python host returned a classified safe failure.")
    }
    throw new GenerationError(document.operation === "submit" ? "PROVIDER_AMBIGUOUS" : "ADAPTER_RESULT_INVALID", "The Seedance Python host stopped without closed evidence.")
  }
  if (response === undefined || response.adapter_protocol_version !== "1" || response.provider !== "openrouter") {
    throw new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance Python host violated protocol version 1.")
  }
  return response
}

const request = (prepared: PreparedGeneration, operation: "submit" | "poll", jobId?: string): Record<string, unknown> => ({
  adapter_protocol_version: "1",
  operation,
  model: prepared.request.model,
  objective: prepared.request.objective,
  video_plan: prepared.request.videoPlan,
  payload: prepared.payload,
  ...(jobId === undefined ? {} : { job_id: jobId }),
})

const adapter = (toolRoot: string): GenerationAdapterService => ({
  invoke: () => Effect.fail(new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance adapter cannot invoke image generation.")),
  submitSeedance: (prepared) => Effect.try({
    try: (): SeedanceSubmission => {
      const response = exchange(toolRoot, request(prepared, "submit"))
      if (!exactKeys(response, ["adapter_protocol_version", "provider", "model", "job_id", "provider_evidence"]) ||
          response.model !== prepared.request.model || typeof response.job_id !== "string") {
        throw new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance submission response is malformed.")
      }
      return { provider: "openrouter", model: prepared.request.model, jobId: response.job_id, providerEvidence: evidence(response.provider_evidence) }
    },
    catch: (error) => error instanceof GenerationError ? error : new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance submission response could not be decoded."),
  }),
  pollSeedance: (prepared, jobId) => Effect.try({
    try: (): SeedancePollResult => {
      const response = exchange(toolRoot, request(prepared, "poll", jobId))
      const common = ["adapter_protocol_version", "provider", "model", "job_id", "status", "provider_evidence"]
      if (response.model !== prepared.request.model || response.job_id !== jobId) {
        throw new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance poll substituted its model or job identity.")
      }
      const providerEvidence = evidence(response.provider_evidence)
      if (response.status === "pending" && exactKeys(response, common)) {
        return { status: "pending", provider: "openrouter", model: prepared.request.model, jobId, providerEvidence }
      }
      if (response.status !== "completed" || !exactKeys(response, [...common, "outputs", "completed_count", "cost"]) ||
          !Array.isArray(response.outputs) || typeof response.completed_count !== "number") {
        throw new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance completion response is malformed.")
      }
      const outputs = response.outputs.map((value) => {
        const output = record(value)
        if (output === undefined || !exactKeys(output, ["application_path", "media_type", "body_base64", "sha256"]) ||
            typeof output.application_path !== "string" || output.media_type !== "video/mp4" ||
            typeof output.body_base64 !== "string" || typeof output.sha256 !== "string") {
          throw new GenerationError("ADAPTER_RESULT_INVALID", "A Seedance output is malformed.")
        }
        const body = Buffer.from(output.body_base64, "base64")
        if (body.toString("base64") !== output.body_base64 || sha256(body) !== output.sha256) {
          throw new GenerationError("ADAPTER_RESULT_INVALID", "A Seedance output changed in transit.")
        }
        return { applicationPath: output.application_path as `outputs/${string}.mp4`, mediaType: "video/mp4" as const, body, sha256: output.sha256 }
      })
      const cost = record(response.cost)
      if (cost === undefined || (cost.state !== "unknown" && cost.state !== "estimated-only" && cost.state !== "actual")) {
        throw new GenerationError("ADAPTER_RESULT_INVALID", "Seedance cost evidence is malformed.")
      }
      return {
        status: "completed", provider: "openrouter", model: prepared.request.model, jobId, providerEvidence,
        outputs, completedCount: response.completed_count,
        cost: cost.state === "actual" ? { state: "actual", actualCostUsd: String(cost.actual_cost_usd) } : { state: cost.state },
      }
    },
    catch: (error) => error instanceof GenerationError ? error : new GenerationError("ADAPTER_RESULT_INVALID", "The Seedance poll response could not be decoded."),
  }),
})

export const seedancePythonAdapter = (toolRoot: string): Effect.Effect<GenerationAdapterService, GenerationError> => Effect.try({
  try: () => {
    if (!process.env.OPENROUTER_API_KEY) throw new GenerationError("ADAPTER_NOT_STARTED", "The logical OpenRouter credential is unavailable.")
    return adapter(toolRoot)
  },
  catch: (error) => error instanceof GenerationError ? error : new GenerationError("ADAPTER_NOT_STARTED", "The Seedance adapter could not be initialized."),
})
