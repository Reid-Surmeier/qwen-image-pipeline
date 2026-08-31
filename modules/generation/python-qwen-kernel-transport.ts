import { spawn } from "node:child_process"

import { Effect } from "effect"

import { GenerationError, type GenerationErrorCode } from "./errors.js"
import { inheritedQwenAdapter, type QwenKernelTransport } from "./inherited-qwen-adapter.js"
import type { GenerationAdapterService } from "./types.js"

const maximumResponseBytes = 128 * 1024 * 1024
const allowedErrorCodes = new Set<GenerationErrorCode>([
  "REFERENCE_BYTES_MISMATCH",
  "PAYLOAD_DESTINATION_INVALID",
  "ADAPTER_NOT_STARTED",
  "ADAPTER_RESULT_INVALID",
  "PROVIDER_SUBSTITUTION",
  "OUTPUT_COUNT_MISMATCH",
  "PROVIDER_AMBIGUOUS",
])

const cleanEnvironment = (): NodeJS.ProcessEnv => {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    throw new GenerationError("ADAPTER_NOT_STARTED", "The logical OpenRouter credential is unavailable.")
  }
  return {
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    OPENROUTER_API_KEY: apiKey,
    ...(process.env.QWEN_OPENROUTER_TIMEOUT_SECONDS === undefined
      ? {}
      : { QWEN_OPENROUTER_TIMEOUT_SECONDS: process.env.QWEN_OPENROUTER_TIMEOUT_SECONDS }),
  }
}

const adapterError = (bytes: Uint8Array): GenerationError | undefined => {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>
    if (Object.keys(value).join(",") !== "adapter_error") return undefined
    const detail = value.adapter_error
    if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return undefined
    const record = detail as Record<string, unknown>
    if (Object.keys(record).sort().join(",") !== "code,message") return undefined
    if (typeof record.code !== "string" || !allowedErrorCodes.has(record.code as GenerationErrorCode)) return undefined
    return new GenerationError(record.code as GenerationErrorCode, "The Python Qwen kernel returned a classified safe failure.")
  } catch {
    return undefined
  }
}

const exchangeWithPython = (request: Uint8Array, environment: NodeJS.ProcessEnv): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", ["-m", "qwen_ui_pipeline.qwen_adapter_host"], {
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    let outputBytes = 0
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
    }
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > maximumResponseBytes) {
        child.kill("SIGKILL")
        finish(() => reject(new GenerationError("ADAPTER_RESULT_INVALID", "The Python Qwen kernel response exceeded its fixed limit.")))
      } else {
        output.push(Buffer.from(chunk))
      }
    })
    child.stderr.on("data", () => undefined)
    child.on("error", () => finish(() => reject(new GenerationError(
      "ADAPTER_RESULT_INVALID",
      "The Python Qwen kernel process could not be started.",
    ))))
    child.on("close", (code) => finish(() => {
      const response = Buffer.concat(output)
      if (code === 0) resolve(response)
      else reject(adapterError(response) ?? new GenerationError(
        "ADAPTER_RESULT_INVALID",
        "The Python Qwen kernel process ended without closed evidence.",
      ))
    }))
    child.stdin.on("error", () => undefined)
    child.stdin.end(Buffer.from(request))
  })

const makePythonQwenKernelTransport = (environment: NodeJS.ProcessEnv): QwenKernelTransport => ({
  exchange: (request) => Effect.tryPromise({
    try: () => exchangeWithPython(request, environment),
    catch: (error) => error instanceof GenerationError
      ? error
      : new GenerationError("ADAPTER_RESULT_INVALID", "The Python Qwen kernel transport failed without named evidence."),
  }),
})

export const pythonQwenKernelTransport = (): Effect.Effect<QwenKernelTransport, GenerationError> =>
  Effect.try({
    try: () => makePythonQwenKernelTransport(cleanEnvironment()),
    catch: (error) => error instanceof GenerationError
      ? error
      : new GenerationError("ADAPTER_NOT_STARTED", "The Python Qwen transport could not be initialized."),
  })

export const inheritedQwenPythonAdapter = (): Effect.Effect<GenerationAdapterService, GenerationError> =>
  pythonQwenKernelTransport().pipe(Effect.map(inheritedQwenAdapter))
