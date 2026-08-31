import assert from "node:assert/strict"
import test from "node:test"

import { EMBEDDED_PROVIDER_SECRET_CASES } from "../../tests/provider-evidence-attacks.js"
import {
  hasDuplicateJsonKeys,
  hasProviderCredentialMaterial,
} from "./index.js"

test("classifies every shared provider diagnostic disguise as unsafe", () => {
  for (const [name, body] of EMBEDDED_PROVIDER_SECRET_CASES) {
    assert.equal(hasProviderCredentialMaterial(JSON.parse(body)), true, name)
  }
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

