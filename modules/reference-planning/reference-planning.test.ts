import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  byteMediaInspector,
  planReferences,
} from "./index.js"
import { makeFixture, sha256 } from "../../tests/control-plane-fixture.js"

test("locks real video bytes and refuses falsified declared properties", async () => {
  const fixture = makeFixture("seedance-video")
  const snapshot = await Effect.runPromise(fixture.files.read("references/neutral.mp4"))
  const input = {
    mode: "seedance-video" as const,
    referenceRoots: ["references"],
    requirements: [
      {
        slot: "motion",
        kind: "video" as const,
        payloadDestination: "/input_references/0/video_url/url",
      },
    ],
    candidates: [
      {
        slot: "motion",
        path: snapshot.applicationPath,
        sha256: sha256(snapshot.bytes),
        kind: "video" as const,
        authorityReason: "Approved neutral fixture evidence.",
        payloadDestination: "/input_references/0/video_url/url",
        declaredMedia: { width: 999, height: 48, durationSeconds: 0.2 },
      },
    ],
  }
  const result = await Effect.runPromiseExit(
    planReferences(input).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
    ),
  )
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.match(String(result.cause), /DECLARED_MEDIA_MISMATCH/)
  }
})
