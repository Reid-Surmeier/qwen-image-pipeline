import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import { inheritedQwenPythonAdapter } from "./index.js"

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
