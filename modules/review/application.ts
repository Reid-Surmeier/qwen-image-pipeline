import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import { Effect } from "effect"

import { fileApplicationFiles } from "../reference-planning/index.js"
import { ReviewPacketError } from "./errors.js"
import { verifyGitCommitObject } from "./git-object.js"
import type { ReviewApplicationService, ReviewApplicationSnapshot } from "./types.js"

const commitPattern = /^[a-f0-9]{40}$/
const refPattern = /^refs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/
const verifiedApplications = new WeakMap<object, (
  paths: ReadonlyArray<string>,
) => Effect.Effect<ReviewApplicationSnapshot, ReviewPacketError>>()

const invalidApplication = (message: string): ReviewPacketError =>
  new ReviewPacketError("ReviewPacketInvalid", message)
const fdPath = (fd: number): string => `/proc/self/fd/${fd}`

const openDirectoryAt = (parentFd: number, name: string): number => {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw invalidApplication("The Git directory path is unsafe.")
  }
  const fd = openSync(`${fdPath(parentFd)}/${name}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  if (!fstatSync(fd).isDirectory()) {
    closeSync(fd)
    throw invalidApplication("Git revision metadata is not a directory.")
  }
  return fd
}

const openAbsoluteDirectory = (path: string): Readonly<{ fd: number; canonicalPath: string }> => {
  if (!isAbsolute(path)) throw invalidApplication("The Git directory path must be absolute.")
  let fd = openSync("/", fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = openDirectoryAt(fd, part)
      closeSync(fd)
      fd = next
    }
    return { fd, canonicalPath: realpathSync(fdPath(fd)) }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

const withDirectoryAt = <Value>(parentFd: number, parts: ReadonlyArray<string>, use: (fd: number) => Value): Value => {
  const opened: number[] = []
  let fd = parentFd
  try {
    for (const part of parts) {
      fd = openDirectoryAt(fd, part)
      opened.push(fd)
    }
    return use(fd)
  } finally {
    for (const item of opened.reverse()) closeSync(item)
  }
}

const readFileAt = (parentFd: number, path: string): string => {
  const parts = path.split("/")
  const name = parts.pop()
  if (name === undefined || !name || name === "." || name === ".." || name.includes("\0")) {
    throw invalidApplication("The Git metadata path is unsafe.")
  }
  return withDirectoryAt(parentFd, parts, (directoryFd) => {
    const fd = openSync(`${fdPath(directoryFd)}/${name}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      if (!fstatSync(fd).isFile()) throw invalidApplication("Git revision metadata is not a regular file.")
      return readFileSync(fd, "utf8").trim()
    } finally {
      closeSync(fd)
    }
  })
}

type GitAuthority = Readonly<{
  applicationRootFd: number
  applicationRoot: string
  gitDirectoryFd: number
  gitDirectory: string
  commonDirectoryFd: number
}>

const closeAuthority = (authority: GitAuthority): void => {
  closeSync(authority.commonDirectoryFd)
  closeSync(authority.gitDirectoryFd)
  closeSync(authority.applicationRootFd)
}

const resolveGitAuthority = (applicationRoot: string): GitAuthority => {
  const root = openAbsoluteDirectory(applicationRoot)
  let gitDirectory: Readonly<{ fd: number; canonicalPath: string }> | undefined
  let commonDirectory: Readonly<{ fd: number; canonicalPath: string }> | undefined
  try {
    try {
      const fd = openDirectoryAt(root.fd, ".git")
      gitDirectory = { fd, canonicalPath: realpathSync(fdPath(fd)) }
    } catch (error) {
      if (!["ENOTDIR", "ELOOP"].includes(String((error as NodeJS.ErrnoException).code))) throw error
      const pointer = readFileAt(root.fd, ".git")
      if (!pointer.startsWith("gitdir: ")) throw invalidApplication("The linked-worktree Git pointer is invalid.")
      gitDirectory = openAbsoluteDirectory(resolve(root.canonicalPath, pointer.slice("gitdir: ".length)))
      const backlink = resolve(gitDirectory.canonicalPath, readFileAt(gitDirectory.fd, "gitdir"))
      if (backlink !== join(root.canonicalPath, ".git")) {
        throw invalidApplication("The linked-worktree Git pointer is not reciprocal.")
      }
    }
    try {
      const commonPointer = readFileAt(gitDirectory.fd, "commondir")
      commonDirectory = openAbsoluteDirectory(resolve(gitDirectory.canonicalPath, commonPointer))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      commonDirectory = openAbsoluteDirectory(gitDirectory.canonicalPath)
    }
    return {
      applicationRootFd: root.fd,
      applicationRoot: root.canonicalPath,
      gitDirectoryFd: gitDirectory.fd,
      gitDirectory: gitDirectory.canonicalPath,
      commonDirectoryFd: commonDirectory.fd,
    }
  } catch (error) {
    if (commonDirectory !== undefined) closeSync(commonDirectory.fd)
    if (gitDirectory !== undefined) closeSync(gitDirectory.fd)
    closeSync(root.fd)
    throw error
  }
}

const packedCommit = (commonDirectoryFd: number, reference: string): string | undefined => {
  let packed: string
  try { packed = readFileAt(commonDirectoryFd, "packed-refs") }
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

const resolveCommit = (authority: GitAuthority): string => {
  const head = readFileAt(authority.gitDirectoryFd, "HEAD")
  let commit: string | undefined
  if (commitPattern.test(head)) commit = head
  else {
    if (!head.startsWith("ref: ")) throw invalidApplication("The application HEAD is invalid.")
    const reference = head.slice("ref: ".length)
    if (!refPattern.test(reference) || reference.includes("..")) {
      throw invalidApplication("The application HEAD reference is unsafe.")
    }
    for (const rootFd of [...new Set([authority.gitDirectoryFd, authority.commonDirectoryFd])]) {
      try {
        const candidate = readFileAt(rootFd, reference)
        if (!commitPattern.test(candidate)) throw invalidApplication("The application HEAD reference is invalid.")
        commit = candidate
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    commit ??= packedCommit(authority.commonDirectoryFd, reference)
  }
  if (commit === undefined) throw invalidApplication("The application HEAD reference could not be resolved.")
  try { verifyGitCommitObject(authority.commonDirectoryFd, commit) }
  catch { throw invalidApplication("The application HEAD does not resolve to an existing verified commit object.") }
  return commit
}

const readCommitNow = (applicationRoot: string): string => {
  const authority = resolveGitAuthority(applicationRoot)
  try { return resolveCommit(authority) }
  finally { closeAuthority(authority) }
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
