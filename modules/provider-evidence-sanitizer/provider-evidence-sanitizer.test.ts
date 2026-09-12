import assert from "node:assert/strict"
import test from "node:test"

import { EMBEDDED_PROVIDER_SECRET_CASES } from "../../tests/provider-evidence-attacks.js"
import {
  hasDuplicateJsonKeys,
  hasProviderCredentialMaterial,
  isSanitizedProviderDocument,
  snapshotProviderEvidence,
} from "./index.js"

test("classifies every shared provider diagnostic disguise as unsafe", () => {
  for (const [name, body] of EMBEDDED_PROVIDER_SECRET_CASES) {
    const document = JSON.parse(body)
    assert.equal(isSanitizedProviderDocument("qwen", document), false, `${name}: qwen`)
    assert.equal(isSanitizedProviderDocument("seedance-submission", document), false, `${name}: submission`)
    assert.equal(isSanitizedProviderDocument("seedance-poll", document), false, `${name}: poll`)
  }
})

test("accepts only the exact persisted schemas for each provider stage", () => {
  assert.equal(isSanitizedProviderDocument("qwen", { id: "fake-qwen-1", status: "completed" }), true)
  assert.equal(isSanitizedProviderDocument("qwen", { request_id: "fake-001", status: "accepted" }), true)
  assert.equal(isSanitizedProviderDocument("qwen", { request_id: "fake-002", status: "succeeded" }), true)
  assert.equal(isSanitizedProviderDocument("qwen", {
    usage: { prompt_tokens: 42, completion_tokens: 7 },
  }), true)
  assert.equal(isSanitizedProviderDocument("seedance-submission", {
    job_id: "seedance-job-1",
    status: "submitted",
  }), true)
  assert.equal(isSanitizedProviderDocument("seedance-poll", {
    job_id: "seedance-job-1",
    status: "pending",
  }), true)
  assert.equal(isSanitizedProviderDocument("seedance-poll", {
    job_id: "seedance-job-1",
    status: "completed",
    polled_at: "2026-08-30T12:00:00.000Z",
    outputs: [{
      application_path: "outputs/result.mp4",
      media_type: "video/mp4",
      sha256: "a".repeat(64),
    }],
    completed_count: 1,
    cost: { state: "estimated-only" },
  }), true)
  assert.equal(isSanitizedProviderDocument("seedance-poll", {
    job_id: "seedance-job-1",
    status: "pending",
    debug: "ordinary provider note",
  }), false)
  assert.equal(isSanitizedProviderDocument("qwen", {
    request_id: "fake-002",
    status: "succeeded",
    debug: "ordinary provider note",
  }), false)
  assert.equal(isSanitizedProviderDocument("seedance-poll", {
    job_id: "seedance-job-1",
    status: "completed",
    polled_at: "not-a-timestamp",
    outputs: [{
      application_path: "outputs/result.mp4",
      media_type: "video/mp4",
      sha256: "a".repeat(64),
    }],
    completed_count: 1,
    cost: { state: "unknown" },
  }), false)

  const symbolField = { id: "fake-qwen-1", status: "completed", [Symbol("debug")]: "hidden" }
  assert.equal(isSanitizedProviderDocument("qwen", symbolField), false)
  const nonEnumerableField = { id: "fake-qwen-1", status: "completed" }
  Object.defineProperty(nonEnumerableField, "debug", { value: "hidden", enumerable: false })
  assert.equal(isSanitizedProviderDocument("qwen", nonEnumerableField), false)
  const inheritedField = Object.assign(Object.create({ debug: "hidden" }), {
    id: "fake-qwen-1",
    status: "completed",
  })
  assert.equal(isSanitizedProviderDocument("qwen", inheritedField), false)

  const outputArrayWithSymbol = [{
    application_path: "outputs/result.mp4",
    media_type: "video/mp4",
    sha256: "a".repeat(64),
  }]
  Object.defineProperty(outputArrayWithSymbol, Symbol("debug"), { value: "hidden" })
  assert.equal(isSanitizedProviderDocument("seedance-poll", {
    job_id: "seedance-job-1",
    status: "completed",
    outputs: outputArrayWithSymbol,
    completed_count: 1,
    cost: { state: "unknown" },
  }), false)

  const outputArrayWithHiddenField = [{
    application_path: "outputs/result.mp4",
    media_type: "video/mp4",
    sha256: "a".repeat(64),
  }]
  Object.defineProperty(outputArrayWithHiddenField, "debug", { value: "hidden", enumerable: false })
  assert.equal(isSanitizedProviderDocument("seedance-poll", {
    job_id: "seedance-job-1",
    status: "completed",
    outputs: outputArrayWithHiddenField,
    completed_count: 1,
    cost: { state: "unknown" },
  }), false)

  assert.equal(isSanitizedProviderDocument("seedance-poll", {
    job_id: "seedance-job-1",
    status: "completed",
    polled_at: "2026-02-30T12:00:00.000Z",
    outputs: [{
      application_path: "outputs/result.mp4",
      media_type: "video/mp4",
      sha256: "a".repeat(64),
    }],
    completed_count: 1,
    cost: { state: "unknown" },
  }), false)

  const throwingField = { id: "fake-qwen-1", status: "completed" }
  Object.defineProperty(throwingField, "debug", {
    enumerable: true,
    get: () => { throw new Error("hostile accessor") },
  })
  assert.doesNotThrow(() => assert.equal(isSanitizedProviderDocument("qwen", throwingField), false))

  const mutatingField = { status: "completed" } as { status: string; id?: string; debug?: string }
  Object.defineProperty(mutatingField, "id", {
    enumerable: true,
    get: () => {
      mutatingField.debug = "statefully introduced unknown field"
      return "fake-qwen-1"
    },
  })
  assert.equal(isSanitizedProviderDocument("qwen", mutatingField), false)
  assert.equal(mutatingField.debug, undefined)
})

test("preserves ordinary provider usage metadata", () => {
  assert.equal(hasProviderCredentialMaterial({
    status: "completed",
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    debug: "provider diagnostic: request_id=run-123",
  }), false)
})

test("detects duplicate object keys without treating malformed JSON as a duplicate", () => {
  assert.equal(hasDuplicateJsonKeys('{"status":"pending","status":"completed"}'), true)
  assert.equal(hasDuplicateJsonKeys('{"status":"pending"}'), false)
  assert.equal(hasDuplicateJsonKeys("{"), false)
})

test("snapshots only a closed data-property evidence wrapper", () => {
  const body = Buffer.from('{"id":"fake-qwen-1","status":"completed"}')
  const exact = {
    mediaType: "application/json",
    body,
    sha256: "a".repeat(64),
  }
  const snapshot = snapshotProviderEvidence(exact)
  assert.notEqual(snapshot, undefined)
  assert.notStrictEqual(snapshot!.body, body)
  assert.deepEqual(Buffer.from(snapshot!.body), body)

  const accessor = { mediaType: "application/json", sha256: "a".repeat(64) }
  Object.defineProperty(accessor, "body", { enumerable: true, get: () => body })
  assert.equal(snapshotProviderEvidence(accessor), undefined)
  assert.equal(snapshotProviderEvidence({ ...exact, debug: "unknown" }), undefined)
})
