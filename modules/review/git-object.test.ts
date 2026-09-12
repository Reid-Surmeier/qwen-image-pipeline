import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { constants as fsConstants, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { deflateSync } from "node:zlib"

import { verifyGitCommitObject } from "./git-object.js"

const sha1 = (bytes: Uint8Array): Buffer => createHash("sha1").update(bytes).digest()
const uint32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320)
  }
  return (crc ^ 0xffffffff) >>> 0
}
const objectHeader = (type: number, size: number): Buffer => {
  const result: number[] = []
  let remaining = Math.floor(size / 16)
  result.push((type << 4) | (size & 0x0f) | (remaining > 0 ? 0x80 : 0))
  while (remaining > 0) {
    const next = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    result.push(next | (remaining > 0 ? 0x80 : 0))
  }
  return Buffer.from(result)
}

test("verifies an exact packed commit object without invoking Git", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qwen-packed-commit-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packDirectory = join(root, "objects/pack")
  mkdirSync(packDirectory, { recursive: true })

  const body = Buffer.from("tree 0000000000000000000000000000000000000000\n\nfixture\n")
  const loose = Buffer.concat([Buffer.from(`commit ${body.byteLength}\0`), body])
  const oid = sha1(loose)
  const entry = Buffer.concat([objectHeader(1, body.byteLength), deflateSync(body)])
  const packWithoutHash = Buffer.concat([Buffer.from("PACK"), uint32(2), uint32(1), entry])
  const packHash = sha1(packWithoutHash)
  const pack = Buffer.concat([packWithoutHash, packHash])

  const fanout = Buffer.alloc(256 * 4)
  for (let index = oid[0]!; index < 256; index += 1) fanout.writeUInt32BE(1, index * 4)
  const indexWithoutHash = Buffer.concat([
    Buffer.from([0xff, 0x74, 0x4f, 0x63]),
    uint32(2),
    fanout,
    oid,
    uint32(crc32(entry)),
    uint32(12),
    packHash,
  ])
  const index = Buffer.concat([indexWithoutHash, sha1(indexWithoutHash)])
  const name = `pack-${packHash.toString("hex")}`
  writeFileSync(join(packDirectory, `${name}.pack`), pack)
  writeFileSync(join(packDirectory, `${name}.idx`), index)

  const rootFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  t.after(() => closeSync(rootFd))
  assert.doesNotThrow(() => verifyGitCommitObject(rootFd, oid.toString("hex")))
  assert.throws(() => verifyGitCommitObject(rootFd, "f".repeat(40)))
})
