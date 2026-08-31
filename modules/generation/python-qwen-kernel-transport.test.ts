import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import { inheritedQwenPythonAdapter, pythonQwenKernelTransport } from "./index.js"

test("the production Qwen adapter refuses a missing logical credential before spawning its host", { concurrency: false }, async () => {
  const original = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    const error = await Effect.runPromise(Effect.flip(inheritedQwenPythonAdapter()))
    assert.equal(error.code, "ADAPTER_NOT_STARTED")
  } finally {
    if (original === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = original
  }
})

test("the production Qwen transport exchanges a closed request with the Python stdio host", {
  concurrency: false,
  skip: process.env.QWEN_BASELINE_OFFLINE === "1"
    ? "ordinary CI forbids provider-capable descendants; run this no-network malformed-request probe locally"
    : false,
}, async () => {
  const original = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = "local-stdio-contract-fixture"
  try {
    const transport = await Effect.runPromise(pythonQwenKernelTransport())
    const error = await Effect.runPromise(Effect.flip(transport.exchange(Buffer.from("{}", "utf8"))))
    assert.equal(error.code, "ADAPTER_NOT_STARTED")
  } finally {
    if (original === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = original
  }
})
