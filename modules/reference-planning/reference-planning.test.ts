import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  type MediaInspectorService,
  byteMediaInspector,
  planReferences,
} from "./index.js"
import { makeFixture, sha256 } from "../../tests/control-plane-fixture.js"

const markerOnlyMp4 = (): Uint8Array => {
  const body = Buffer.alloc(76)
  body.writeUInt32BE(12, 0)
  body.write("ftyp", 4, "ascii")
  body.writeUInt32BE(28, 12)
  body.write("mvhd", 16, "ascii")
  body.writeUInt32BE(1_000, 32)
  body.writeUInt32BE(200, 36)
  body.writeUInt32BE(36, 40)
  body.write("tkhd", 44, "ascii")
  body.writeUInt32BE(64 * 65_536, 68)
  body.writeUInt32BE(48 * 65_536, 72)
  return body
}

test("refuses a PNG-like prefix without the complete signature and IHDR structure", async () => {
  const forged = Buffer.alloc(24)
  forged.set([0x89, 0x50, 0x4e, 0x47], 0)
  forged.writeUInt32BE(16, 16)
  forged.writeUInt32BE(16, 20)
  const result = await Effect.runPromiseExit(byteMediaInspector.inspect({
    applicationPath: "references/forged.png",
    bytes: forged,
    sha256: sha256(forged),
  }))
  assert.equal(result._tag, "Failure")
})

test("refuses MP4 marker bytes without a structural playable video track", async () => {
  const forged = markerOnlyMp4()
  const result = await Effect.runPromiseExit(byteMediaInspector.inspect({
    applicationPath: "references/forged.mp4",
    bytes: forged,
    sha256: sha256(forged),
  }))
  assert.equal(result._tag, "Failure")
})

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

test("refuses two references assigned to the same provider payload destination", async () => {
  const fixture = makeFixture("qwen-image")
  const snapshot = await Effect.runPromise(fixture.files.read("references/neutral.png"))
  const destination = "/input_references/0/image_url/url"
  const result = await Effect.runPromiseExit(
    planReferences({
      mode: "qwen-image",
      referenceRoots: ["references"],
      requirements: [
        { slot: "source", kind: "image", payloadDestination: destination },
        { slot: "overlay", kind: "image", payloadDestination: destination },
      ],
      candidates: [
        {
          slot: "source",
          path: snapshot.applicationPath,
          sha256: sha256(snapshot.bytes),
          kind: "image",
          authorityReason: "Approved source evidence.",
          payloadDestination: destination,
        },
        {
          slot: "overlay",
          path: snapshot.applicationPath,
          sha256: sha256(snapshot.bytes),
          kind: "image",
          authorityReason: "Approved overlay evidence.",
          payloadDestination: destination,
        },
      ],
    }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
    ),
  )
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") {
    assert.match(String(result.cause), /PAYLOAD_DESTINATION_INVALID/)
  }
})

test("an injected inspector must prove the exact kind and media type for unknown bytes", async () => {
  const fixture = makeFixture("qwen-image", {
    files: (files) => files.set("references/custom.rgba.json", Buffer.from("custom-bytes")),
  })
  const snapshot = await Effect.runPromise(fixture.files.read("references/custom.rgba.json"))
  const input = {
    mode: "qwen-image" as const,
    referenceRoots: ["references"],
    requirements: [{
      slot: "source",
      kind: "image" as const,
      payloadDestination: "/input_references/0/image_url/url",
    }],
    candidates: [{
      slot: "source",
      path: snapshot.applicationPath,
      sha256: sha256(snapshot.bytes),
      kind: "image" as const,
      authorityReason: "Application-owned custom image evidence.",
      payloadDestination: "/input_references/0/image_url/url",
    }],
  }
  const unprovedInspector = {
    inspect: () => Effect.succeed({ width: 1, height: 1 }),
  } as unknown as MediaInspectorService
  const refused = await Effect.runPromiseExit(
    planReferences(input).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, unprovedInspector),
    ),
  )
  assert.equal(refused._tag, "Failure")

  const provedInspector = {
    inspect: () => Effect.succeed({
      kind: "image" as const,
      mediaType: "application/vnd.qwen.rgba+json" as const,
      width: 1,
      height: 1,
    }),
  } as MediaInspectorService
  const plan = await Effect.runPromise(
    planReferences(input).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, provedInspector),
    ),
  )
  assert.equal(plan.references[0]?.kind, "image")
  assert.equal(plan.references[0]?.mediaType, "application/vnd.qwen.rgba+json")
})

test("refuses an inspector classification that contradicts the required kind", async () => {
  const fixture = makeFixture("qwen-image", {
    files: (files) => files.set("references/custom.bin", Buffer.from("custom-bytes")),
  })
  const snapshot = await Effect.runPromise(fixture.files.read("references/custom.bin"))
  const inspector = {
    inspect: () => Effect.succeed({
      kind: "video" as const,
      mediaType: "video/mp4" as const,
      width: 1,
      height: 1,
      durationSeconds: 1,
    }),
  } as MediaInspectorService
  const result = await Effect.runPromiseExit(
    planReferences({
      mode: "qwen-image",
      referenceRoots: ["references"],
      requirements: [{ slot: "source", kind: "image", payloadDestination: "/input_references/0/image_url/url" }],
      candidates: [{
        slot: "source",
        path: snapshot.applicationPath,
        sha256: sha256(snapshot.bytes),
        kind: "image",
        authorityReason: "Application-owned custom evidence.",
        payloadDestination: "/input_references/0/image_url/url",
      }],
    }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, inspector),
    ),
  )
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") assert.match(String(result.cause), /REFERENCE_KIND_MISMATCH/)
})

test("refuses an inspector that relabels known PNG bytes as normalized RGBA", async () => {
  const fixture = makeFixture("qwen-image")
  const snapshot = await Effect.runPromise(fixture.files.read("references/neutral.png"))
  const inspector: MediaInspectorService = {
    inspect: () => Effect.succeed({
      kind: "image",
      mediaType: "application/vnd.qwen.rgba+json",
      width: 16,
      height: 16,
    }),
  }
  const result = await Effect.runPromiseExit(planReferences({
    mode: "qwen-image",
    referenceRoots: ["references"],
    requirements: [{ slot: "source", kind: "image", payloadDestination: "/input_references/0/image_url/url" }],
    candidates: [{
      slot: "source",
      path: snapshot.applicationPath,
      sha256: sha256(snapshot.bytes),
      kind: "image",
      authorityReason: "Known PNG evidence.",
      payloadDestination: "/input_references/0/image_url/url",
    }],
  }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, inspector),
  ))
  assert.equal(result._tag, "Failure")
})
