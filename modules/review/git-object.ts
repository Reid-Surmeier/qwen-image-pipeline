import { createHash } from "node:crypto"
import { constants as fsConstants, closeSync, fstatSync, openSync, readFileSync, readdirSync } from "node:fs"
import { inflateSync } from "node:zlib"

type GitObject = Readonly<{ type: "commit" | "tree" | "blob" | "tag"; body: Buffer }>

const sha1Pattern = /^[a-f0-9]{40}$/
const objectTypes = new Map<number, GitObject["type"]>([
  [1, "commit"],
  [2, "tree"],
  [3, "blob"],
  [4, "tag"],
])

const invalid = (): Error => new Error("The application commit object is invalid or missing.")
const fdPath = (fd: number): string => `/proc/self/fd/${fd}`

const openDirectoryAt = (parentFd: number, name: string): number => {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw invalid()
  const fd = openSync(`${fdPath(parentFd)}/${name}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  if (!fstatSync(fd).isDirectory()) {
    closeSync(fd)
    throw invalid()
  }
  return fd
}

const withDirectoryAt = <Value>(parentFd: number, names: ReadonlyArray<string>, use: (fd: number) => Value): Value => {
  const opened: number[] = []
  let fd = parentFd
  try {
    for (const name of names) {
      fd = openDirectoryAt(fd, name)
      opened.push(fd)
    }
    return use(fd)
  } finally {
    for (const item of opened.reverse()) closeSync(item)
  }
}

const readFileAt = (parentFd: number, path: string): Buffer => {
  const parts = path.split("/")
  const name = parts.pop()
  if (name === undefined || !name || name === "." || name === ".." || name.includes("\0")) throw invalid()
  return withDirectoryAt(parentFd, parts, (directoryFd) => {
    const fd = openSync(`${fdPath(directoryFd)}/${name}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      if (!fstatSync(fd).isFile()) throw invalid()
      return readFileSync(fd)
    } finally {
      closeSync(fd)
    }
  })
}

const readMaybe = (parentFd: number, path: string): Buffer | undefined => {
  try { return readFileAt(parentFd, path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

const sha1 = (bytes: Uint8Array): Buffer => createHash("sha1").update(bytes).digest()
const objectBytes = (object: GitObject): Buffer => Buffer.concat([
  Buffer.from(`${object.type} ${object.body.byteLength}\0`),
  object.body,
])

const parseLoose = (compressed: Buffer, expectedOid: string): GitObject => {
  const bytes = inflateSync(compressed)
  if (sha1(bytes).toString("hex") !== expectedOid) throw invalid()
  const separator = bytes.indexOf(0)
  if (separator < 0) throw invalid()
  const header = bytes.subarray(0, separator).toString("ascii")
  const match = /^(commit|tree|blob|tag) ([0-9]+)$/.exec(header)
  const body = bytes.subarray(separator + 1)
  if (match === null || Number(match[2]) !== body.byteLength) throw invalid()
  return { type: match[1] as GitObject["type"], body }
}

const uint32 = (bytes: Buffer, offset: number): number => {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw invalid()
  return bytes.readUInt32BE(offset)
}

const uint64 = (bytes: Buffer, offset: number): number => {
  if (offset < 0 || offset + 8 > bytes.byteLength) throw invalid()
  const value = bytes.readBigUInt64BE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid()
  return Number(value)
}

type PackIndex = Readonly<{ packName: string; bytes: Buffer; count: number; oidStart: number; offsetStart: number }>

const parseIndex = (packName: string, bytes: Buffer): PackIndex => {
  if (bytes.byteLength < 8 + 1024 + 40 || uint32(bytes, 0) !== 0xff744f63 || uint32(bytes, 4) !== 2) throw invalid()
  const count = uint32(bytes, 8 + 255 * 4)
  const oidStart = 8 + 256 * 4
  const offsetStart = oidStart + count * 20 + count * 4
  if (offsetStart + count * 4 + 40 > bytes.byteLength) throw invalid()
  const expectedIndexHash = bytes.subarray(bytes.byteLength - 20)
  if (!sha1(bytes.subarray(0, bytes.byteLength - 20)).equals(expectedIndexHash)) throw invalid()
  return { packName, bytes, count, oidStart, offsetStart }
}

const locateOffset = (index: PackIndex, oid: string): number | undefined => {
  const target = Buffer.from(oid, "hex")
  let low = 0
  let high = index.count - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const found = index.bytes.subarray(index.oidStart + middle * 20, index.oidStart + (middle + 1) * 20)
    const order = Buffer.compare(found, target)
    if (order === 0) {
      const encoded = uint32(index.bytes, index.offsetStart + middle * 4)
      if ((encoded & 0x80000000) === 0) return encoded
      const largeIndex = encoded & 0x7fffffff
      return uint64(index.bytes, index.offsetStart + index.count * 4 + largeIndex * 8)
    }
    if (order < 0) low = middle + 1
    else high = middle - 1
  }
  return undefined
}

const readVariableInteger = (bytes: Buffer, position: { value: number }): number => {
  let result = 0
  let shift = 0
  while (true) {
    if (position.value >= bytes.byteLength || shift > 49) throw invalid()
    const byte = bytes[position.value++]!
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return result
    shift += 7
  }
}

const applyDelta = (base: Buffer, delta: Buffer): Buffer => {
  const position = { value: 0 }
  if (readVariableInteger(delta, position) !== base.byteLength) throw invalid()
  const expectedSize = readVariableInteger(delta, position)
  const parts: Buffer[] = []
  let produced = 0
  while (position.value < delta.byteLength) {
    const opcode = delta[position.value++]!
    if ((opcode & 0x80) !== 0) {
      let offset = 0
      let size = 0
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          if (position.value >= delta.byteLength) throw invalid()
          offset += delta[position.value++]! * 2 ** (bit * 8)
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          if (position.value >= delta.byteLength) throw invalid()
          size += delta[position.value++]! * 2 ** (bit * 8)
        }
      }
      if (size === 0) size = 0x10000
      if (offset + size > base.byteLength) throw invalid()
      parts.push(base.subarray(offset, offset + size))
      produced += size
    } else {
      if (opcode === 0 || position.value + opcode > delta.byteLength) throw invalid()
      parts.push(delta.subarray(position.value, position.value + opcode))
      position.value += opcode
      produced += opcode
    }
    if (produced > expectedSize) throw invalid()
  }
  if (produced !== expectedSize) throw invalid()
  return Buffer.concat(parts, expectedSize)
}

type PackContext = Readonly<{ pack: Buffer; index: PackIndex }>

const validatePack = (pack: Buffer, index: PackIndex): void => {
  if (
    pack.byteLength < 32 || pack.subarray(0, 4).toString("ascii") !== "PACK" ||
    ![2, 3].includes(uint32(pack, 4)) || uint32(pack, 8) !== index.count
  ) throw invalid()
  const trailer = pack.subarray(pack.byteLength - 20)
  const indexedPackHash = index.bytes.subarray(index.bytes.byteLength - 40, index.bytes.byteLength - 20)
  if (!sha1(pack.subarray(0, pack.byteLength - 20)).equals(trailer) || !trailer.equals(indexedPackHash)) throw invalid()
}

const unpackAt = (
  context: PackContext,
  offset: number,
  loadByOid: (oid: string, visited: ReadonlySet<string>) => GitObject,
  visited: ReadonlySet<string>,
  offsets: ReadonlySet<number> = new Set(),
): GitObject => {
  if (offset < 12 || offset >= context.pack.byteLength - 20 || offsets.has(offset)) throw invalid()
  const nextOffsets = new Set(offsets).add(offset)
  let position = offset
  let byte = context.pack[position++]!
  const typeCode = (byte >> 4) & 0x07
  let declaredSize = byte & 0x0f
  let shift = 4
  while ((byte & 0x80) !== 0) {
    if (position >= context.pack.byteLength - 20 || shift > 49) throw invalid()
    byte = context.pack[position++]!
    declaredSize += (byte & 0x7f) * 2 ** shift
    shift += 7
  }
  let base: GitObject | undefined
  if (typeCode === 6) {
    if (position >= context.pack.byteLength - 20) throw invalid()
    let distanceByte = context.pack[position++]!
    let distance = distanceByte & 0x7f
    while ((distanceByte & 0x80) !== 0) {
      if (position >= context.pack.byteLength - 20) throw invalid()
      distanceByte = context.pack[position++]!
      distance = (distance + 1) * 128 + (distanceByte & 0x7f)
    }
    base = unpackAt(context, offset - distance, loadByOid, visited, nextOffsets)
  } else if (typeCode === 7) {
    if (position + 20 > context.pack.byteLength - 20) throw invalid()
    const baseOid = context.pack.subarray(position, position + 20).toString("hex")
    position += 20
    base = loadByOid(baseOid, visited)
  }
  const inflated = inflateSync(context.pack.subarray(position, context.pack.byteLength - 20))
  if (inflated.byteLength !== declaredSize) throw invalid()
  if (base !== undefined) return { type: base.type, body: applyDelta(base.body, inflated) }
  const type = objectTypes.get(typeCode)
  if (type === undefined) throw invalid()
  return { type, body: inflated }
}

const packIndexes = (commonDirectoryFd: number): ReadonlyArray<PackIndex> => {
  return withDirectoryAt(commonDirectoryFd, ["objects", "pack"], (packFd) =>
    readdirSync(fdPath(packFd))
      .filter((name) => /^pack-[a-f0-9]{40}\.idx$/.test(name))
      .sort()
      .map((name) => parseIndex(name.slice(0, -4), readFileAt(packFd, name))))
}

export const verifyGitCommitObject = (commonDirectoryFd: number, oid: string): void => {
  if (!sha1Pattern.test(oid)) throw invalid()
  const visited = new Set<string>()
  const loadByOid = (requestedOid: string, prior: ReadonlySet<string>): GitObject => {
    if (!sha1Pattern.test(requestedOid) || prior.has(requestedOid)) throw invalid()
    const next = new Set(prior).add(requestedOid)
    const loose = readMaybe(commonDirectoryFd, `objects/${requestedOid.slice(0, 2)}/${requestedOid.slice(2)}`)
    if (loose !== undefined) return parseLoose(loose, requestedOid)
    for (const index of packIndexes(commonDirectoryFd)) {
      const offset = locateOffset(index, requestedOid)
      if (offset === undefined) continue
      const pack = readFileAt(commonDirectoryFd, `objects/pack/${index.packName}.pack`)
      validatePack(pack, index)
      const object = unpackAt({ pack, index }, offset, loadByOid, next)
      if (sha1(objectBytes(object)).toString("hex") !== requestedOid) throw invalid()
      return object
    }
    throw invalid()
  }
  const object = loadByOid(oid, visited)
  if (object.type !== "commit") throw invalid()
}
