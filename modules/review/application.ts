import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { Effect } from "effect"

import { fileApplicationFiles } from "../reference-planning/index.js"
import { ReviewPacketError } from "./errors.js"
import type { ReviewApplicationService, ReviewApplicationSnapshot } from "./types.js"

const commitPattern = /^[a-f0-9]{40}$/
const refPattern = /^refs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/
const verifiedApplications = new WeakMap<object, (
  paths: ReadonlyArray<string>,
) => Effect.Effect<ReviewApplicationSnapshot, ReviewPacketError>>()

const invalidApplication = (message: string): ReviewPacketError =>
  new ReviewPacketError("ReviewPacketInvalid", message)

const inside = (root: string, target: string): boolean => {
  const offset = relative(root, target)
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
}

const readRealFile = (path: string): string => {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile()) throw invalidApplication("Git revision metadata is not a regular file.")
    return readFileSync(fd, "utf8").trim()
  } finally {
    closeSync(fd)
  }
}

const realDirectory = (path: string): string => {
  if (!lstatSync(path).isDirectory()) throw invalidApplication("Git revision metadata is not a directory.")
  return realpathSync(path)
}

const resolveGitDirectories = (applicationRoot: string): Readonly<{ gitDirectory: string; commonDirectory: string }> => {
  const root = realDirectory(applicationRoot)
  const marker = join(root, ".git")
  const metadata = lstatSync(marker)
  let gitDirectory: string
  if (metadata.isDirectory()) {
    gitDirectory = realDirectory(marker)
    if (!inside(root, gitDirectory)) throw invalidApplication("The application Git directory escaped its repository.")
  } else if (metadata.isFile()) {
    const pointer = readRealFile(marker)
    if (!pointer.startsWith("gitdir: ")) throw invalidApplication("The linked-worktree Git pointer is invalid.")
    gitDirectory = realDirectory(resolve(root, pointer.slice("gitdir: ".length)))
    const backlinkPath = join(gitDirectory, "gitdir")
    const backlink = resolve(gitDirectory, readRealFile(backlinkPath))
    if (realpathSync(backlink) !== realpathSync(marker)) {
      throw invalidApplication("The linked-worktree Git pointer is not reciprocal.")
    }
  } else {
    throw invalidApplication("The application does not have supported Git metadata.")
  }
  let commonDirectory = gitDirectory
  try {
    const commonPointer = readRealFile(join(gitDirectory, "commondir"))
    commonDirectory = realDirectory(resolve(gitDirectory, commonPointer))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return { gitDirectory, commonDirectory }
}

const packedCommit = (commonDirectory: string, reference: string): string | undefined => {
  let packed: string
  try { packed = readRealFile(join(commonDirectory, "packed-refs")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^") || !line.trim()) continue
    const [commit, name, ...extra] = line.trim().split(" ")
    if (name === reference && extra.length === 0 && commitPattern.test(commit ?? "")) return commit
  }
  return undefined
}

const readCommitNow = (applicationRoot: string): string => {
  const { gitDirectory, commonDirectory } = resolveGitDirectories(applicationRoot)
  const head = readRealFile(join(gitDirectory, "HEAD"))
  if (commitPattern.test(head)) return head
  if (!head.startsWith("ref: ")) throw invalidApplication("The application HEAD is invalid.")
  const reference = head.slice("ref: ".length)
  if (!refPattern.test(reference) || reference.includes("..")) {
    throw invalidApplication("The application HEAD reference is unsafe.")
  }
  for (const root of [...new Set([gitDirectory, commonDirectory])]) {
    try {
      const commit = readRealFile(join(root, reference))
      if (!commitPattern.test(commit)) throw invalidApplication("The application HEAD reference is invalid.")
      return commit
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const packed = packedCommit(commonDirectory, reference)
  if (packed !== undefined) return packed
  throw invalidApplication("The application HEAD reference could not be resolved.")
}

const readCommit = (applicationRoot: string): Effect.Effect<string, ReviewPacketError> => Effect.try({
  try: () => readCommitNow(applicationRoot),
  catch: (error) => error instanceof ReviewPacketError
    ? error
    : invalidApplication("The application commit could not be derived from its repository."),
})

export const fileReviewApplication = (
  applicationRoot: string,
): Effect.Effect<ReviewApplicationService, ReviewPacketError> => Effect.gen(function*() {
  if (!isAbsolute(applicationRoot)) {
    return yield* Effect.fail(invalidApplication("The review application root must be absolute."))
  }
  const files = yield* fileApplicationFiles(applicationRoot).pipe(Effect.mapError(() =>
    invalidApplication("The review application root could not be verified.")))
  yield* readCommit(applicationRoot)
  const service: ReviewApplicationService = Object.freeze({ _tag: "VerifiedReviewApplication" as const })
  verifiedApplications.set(service, (paths) => Effect.gen(function*() {
    const before = yield* readCommit(applicationRoot)
    const snapshots = yield* Effect.forEach([...new Set(paths)], (applicationPath) =>
      files.read(applicationPath).pipe(Effect.mapError(() =>
        invalidApplication(`Review application evidence could not be read at ${applicationPath}.`))),
    { concurrency: 1 })
    const after = yield* readCommit(applicationRoot)
    if (before !== after) {
      return yield* Effect.fail(invalidApplication("The application commit changed while review evidence was read."))
    }
    return Object.freeze({
      applicationCommit: before,
      files: new Map(snapshots.map((snapshot) => [snapshot.applicationPath, snapshot.bytes])),
    })
  }))
  return service
})

export const readVerifiedReviewApplication = (
  service: ReviewApplicationService,
  paths: ReadonlyArray<string>,
): Effect.Effect<ReviewApplicationSnapshot, ReviewPacketError> => {
  const read = verifiedApplications.get(service)
  return read === undefined
    ? Effect.fail(invalidApplication("The application revision was not derived from a verified repository."))
    : read(paths)
}
