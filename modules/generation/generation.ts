import { createHash } from "node:crypto"
import { Effect } from "effect"

import { GenerationError } from "./errors.js"
import type {
  GeneratedOutput,
  GenerationAdapterService,
  GenerationRequest,
  GenerationResult,
} from "./types.js"

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

const FAKE_PNG_OUTPUT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

const FAKE_MP4_OUTPUT = Buffer.from(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMybW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlx0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAAAwAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAAAAABAAAAAAHUbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABf21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAT9zdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAMABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGliYjI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UR7ARAAAAMAEAAAAwFA8SJZYAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAABzKAAAcygAAAAYc3R0cwAAAAAAAAABAAAAAgAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAAtMAAAAOAAAAFHN0Y28AAAAAAAAAAQAAA2IAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAAC6W1kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbA==",
  "base64",
)

export type FakeGenerationOptions = Readonly<{
  simulateError?: GenerationError
  simulateTimeout?: boolean
  customOutputs?: ReadonlyArray<{ name: string; bytes: Uint8Array; mediaType: string }>
  jobId?: string
  costUsd?: string
}>

export const createFakeGenerationAdapter = (
  options: FakeGenerationOptions = {},
): GenerationAdapterService & {
  readonly getInvocationCount: () => number
  readonly getPollCount: () => number
  readonly getLastRequest: () => GenerationRequest | undefined
} => {
  let invocations = 0
  let polls = 0
  let lastReq: GenerationRequest | undefined

  const produceOutputs = (request: GenerationRequest): ReadonlyArray<GeneratedOutput> => {
    if (options.customOutputs !== undefined) {
      return options.customOutputs.map((item) => ({
        name: item.name,
        bytes: item.bytes,
        sha256: sha256(item.bytes),
        byteLength: item.bytes.byteLength,
        mediaType: item.mediaType,
      }))
    }
    const isVideo = request.request.mode === "seedance-video"
    const templateBytes = isVideo ? FAKE_MP4_OUTPUT : FAKE_PNG_OUTPUT
    const mediaType = isVideo ? "video/mp4" : "image/png"
    const ext = isVideo ? "mp4" : "png"

    const outputs: Array<GeneratedOutput> = []
    for (let i = 0; i < request.request.requestedCount; i++) {
      const name = `output-${String(i + 1).padStart(2, "0")}.${ext}`
      const bytes = new Uint8Array(templateBytes)
      outputs.push({
        name,
        bytes,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        mediaType,
      })
    }
    return outputs
  }

  const validateRequest = (genReq: GenerationRequest): void => {
    if (genReq.request.provider !== "openrouter") {
      throw new GenerationError(
        "PROVIDER_SUBSTITUTION_FORBIDDEN",
        `Only OpenRouter provider is permitted, got ${genReq.request.provider}`,
      )
    }
    if (genReq.referencesData) {
      for (const ref of genReq.request.references) {
        const found = genReq.referencesData.find(
          (item) => item.payloadDestination === ref.payloadDestination,
        )
        if (!found) {
          throw new GenerationError(
            "REFERENCE_PAYLOAD_MISMATCH",
            `Locked reference at ${ref.applicationPath} was not included at payload destination ${ref.payloadDestination}`,
          )
        }
      }
    }
  }

  return {
    getInvocationCount: () => invocations,
    getPollCount: () => polls,
    getLastRequest: () => lastReq,

    execute: (genReq) => Effect.gen(function*() {
      invocations++
      lastReq = genReq

      if (options.simulateError) {
        return yield* Effect.fail(options.simulateError)
      }
      if (options.simulateTimeout) {
        return yield* Effect.fail(
          new GenerationError("PROVIDER_TIMEOUT", "OpenRouter provider request timed out"),
        )
      }

      validateRequest(genReq)

      const isVideo = genReq.request.mode === "seedance-video"
      const outputs = produceOutputs(genReq)

      const result: GenerationResult = {
        status: 200,
        bodyDigest: sha256(Buffer.from(JSON.stringify({ simulated: true }))),
        sanitizedBody: {
          id: "gen-fake-123",
          model: genReq.request.model,
          provider: "openrouter",
        },
        safeIdentifiers: ["gen-fake-123"],
        outputs,
        jobId: options.jobId ?? (isVideo ? "seedance-job-789" : undefined),
        costUsd: options.costUsd ?? genReq.request.estimatedMaximumCostUsd,
      }
      return result
    }),

    poll: (jobId, genReq) => Effect.gen(function*() {
      polls++
      lastReq = genReq

      if (options.simulateError) {
        return yield* Effect.fail(options.simulateError)
      }
      validateRequest(genReq)

      const outputs = produceOutputs(genReq)
      const result: GenerationResult = {
        status: 200,
        bodyDigest: sha256(Buffer.from(JSON.stringify({ jobId, completed: true }))),
        sanitizedBody: {
          id: jobId,
          model: genReq.request.model,
          status: "completed",
        },
        safeIdentifiers: [jobId],
        outputs,
        jobId,
        costUsd: options.costUsd ?? genReq.request.estimatedMaximumCostUsd,
      }
      return result
    }),
  }
}
