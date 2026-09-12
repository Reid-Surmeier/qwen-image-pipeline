import { createHash } from "node:crypto"
import { constants as fsConstants, closeSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"

import { Effect } from "effect"

import { RunContractError } from "./errors.js"
import type { PlanningIdentityService, ToolIdentity } from "./types.js"

const MANIFEST_PATH = "tool-artifact.json"
const verifiedIdentities = new WeakMap<object, () => ToolIdentity>()

const invalidArtifact = (message: string): RunContractError =>
  new RunContractError("TOOL_ARTIFACT_INVALID", message)

const safeRelative = (value: string): boolean =>
  value.length > 0 &&
  !isAbsolute(value) &&
  !value.startsWith("~") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !/^[A-Za-z]:/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const inside = (root: string, target: string): boolean => {
  const offset = relative(root, target)
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
}

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")

const comparePath = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const readAnchoredFile = (rootFd: number, verifiedRoot: string, applicationPath: string): Buffer => {
  if (!safeRelative(applicationPath)) throw invalidArtifact("The tool artifact manifest contains an unsafe path.")
  const openDirectories: Array<number> = []
  let parentFd = rootFd
  try {
    const parts = applicationPath.split("/")
    for (const part of parts.slice(0, -1)) {
      const directoryFd = openSync(
        `/proc/self/fd/${parentFd}/${part}`,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      )
      openDirectories.push(directoryFd)
      parentFd = directoryFd
    }
    const fileFd = openSync(
      `/proc/self/fd/${parentFd}/${parts.at(-1)!}`,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
    try {
      const actual = realpathSync(`/proc/self/fd/${fileFd}`)
      if (!inside(verifiedRoot, actual) || !fstatSync(fileFd).isFile()) {
        throw invalidArtifact("A tool artifact file escapes the installed artifact root.")
      }
      return readFileSync(fileFd)
    } finally {
      closeSync(fileFd)
    }
  } catch (error) {
    if (error instanceof RunContractError) throw error
    throw invalidArtifact("The installed tool artifact could not be read safely.")
  } finally {
    for (const directoryFd of openDirectories.reverse()) closeSync(directoryFd)
  }
}

const collectInventory = (directoryFd: number, prefix = ""): ReadonlyArray<string> => {
  const paths: Array<string> = []
  const directory = `/proc/self/fd/${directoryFd}`
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const applicationPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) throw invalidArtifact("The installed tool artifact contains a symbolic link.")
    if (entry.isDirectory()) {
      const childFd = openSync(
        `${directory}/${entry.name}`,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      )
      try {
        paths.push(...collectInventory(childFd, applicationPath))
      } finally {
        closeSync(childFd)
      }
    }
    else if (entry.isFile()) paths.push(applicationPath)
    else throw invalidArtifact("The installed tool artifact contains an unsupported filesystem entry.")
  }
  return paths.sort()
}

const readIdentity = (toolRoot: string): ToolIdentity => {
  if (!isAbsolute(toolRoot)) throw invalidArtifact("The installed tool artifact root must be absolute.")
  const rootFd = openSync(toolRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  try {
    if (!fstatSync(rootFd).isDirectory()) {
      throw invalidArtifact("The installed tool artifact root must be a real directory.")
    }
    const verifiedRoot = realpathSync(`/proc/self/fd/${rootFd}`)
    const manifestBytes = readAnchoredFile(rootFd, verifiedRoot, MANIFEST_PATH)
    let parsed: unknown
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"))
    } catch {
      throw invalidArtifact("The installed tool artifact manifest is not valid JSON.")
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidArtifact("The installed tool artifact manifest must be an object.")
    }
    const manifest = parsed as Readonly<Record<string, unknown>>
    if (
      Object.keys(manifest).sort().join(",") !== "artifactSha256,files,schemaVersion" ||
      manifest.schemaVersion !== "1" ||
      typeof manifest.artifactSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.artifactSha256) ||
      !Array.isArray(manifest.files) || manifest.files.length < 4
    ) throw invalidArtifact("The installed tool artifact manifest has an unsupported schema.")
    const files = manifest.files.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw invalidArtifact("A tool artifact inventory entry is invalid.")
      }
      const entry = value as Readonly<Record<string, unknown>>
      if (
        Object.keys(entry).sort().join(",") !== "path,sha256" ||
        typeof entry.path !== "string" || !safeRelative(entry.path) || entry.path === MANIFEST_PATH ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
      ) throw invalidArtifact("A tool artifact inventory entry is invalid.")
      return { path: entry.path, sha256: entry.sha256 }
    }).sort((left, right) => comparePath(left.path, right.path))
    if (new Set(files.map((file) => file.path)).size !== files.length) {
      throw invalidArtifact("The tool artifact inventory contains duplicate paths.")
    }
    const actualInventory = collectInventory(rootFd).filter((path) => path !== MANIFEST_PATH)
    if (JSON.stringify(actualInventory) !== JSON.stringify(files.map((file) => file.path))) {
      throw invalidArtifact("The installed tool artifact inventory is incomplete or contains unlisted files.")
    }
    for (const file of files) {
      if (sha256(readAnchoredFile(rootFd, verifiedRoot, file.path)) !== file.sha256) {
        throw invalidArtifact(`The installed tool artifact file ${file.path} failed integrity verification.`)
      }
    }
    const artifactSha256 = sha256(JSON.stringify({ files }))
    if (artifactSha256 !== manifest.artifactSha256) {
      throw invalidArtifact("The installed tool artifact digest does not match its verified inventory.")
    }
    const release = readAnchoredFile(rootFd, verifiedRoot, "RELEASE").toString("utf8").trimEnd()
    const commit = readAnchoredFile(rootFd, verifiedRoot, "COMMIT").toString("utf8").trimEnd()
    let profile: unknown
    try {
      profile = JSON.parse(readAnchoredFile(rootFd, verifiedRoot, "VERSION_PROFILE.json").toString("utf8"))
    } catch {
      throw invalidArtifact("The installed tool version profile is not valid JSON.")
    }
    if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
      throw invalidArtifact("The installed tool version profile must be an object.")
    }
    const versions = profile as Readonly<Record<string, unknown>>
    if (
      !/^v\d+\.\d+\.\d+$/.test(release) || !/^[a-f0-9]{40}$/.test(commit) ||
      Object.keys(versions).sort().join(",") !== "adapterProtocolVersion,procedureVersion,runSchemaVersion" ||
      typeof versions.procedureVersion !== "string" || !/^\d+$/.test(versions.procedureVersion) ||
      typeof versions.runSchemaVersion !== "string" || !/^\d+$/.test(versions.runSchemaVersion) ||
      typeof versions.adapterProtocolVersion !== "string" || !/^\d+$/.test(versions.adapterProtocolVersion)
    ) throw invalidArtifact("The installed tool identity files are invalid.")
    return Object.freeze({
      release,
      commit,
      artifactSha256,
      procedureVersion: versions.procedureVersion,
      runSchemaVersion: versions.runSchemaVersion,
      adapterProtocolVersion: versions.adapterProtocolVersion,
    })
  } finally {
    closeSync(rootFd)
  }
}

const buildIdentity = (toolRoot: string): PlanningIdentityService => {
  const service: PlanningIdentityService = Object.freeze({ installedTool: readIdentity(toolRoot) })
  verifiedIdentities.set(service, () => readIdentity(toolRoot))
  return service
}

export const filePlanningIdentity = (
  toolRoot: string,
): Effect.Effect<PlanningIdentityService, RunContractError> => Effect.try({
  try: () => buildIdentity(toolRoot),
  catch: (error) => error instanceof RunContractError
    ? error
    : invalidArtifact("The installed tool artifact could not be verified."),
})

export const isVerifiedPlanningIdentity = (service: PlanningIdentityService): boolean =>
  verifiedIdentities.has(service)

export const refreshVerifiedPlanningIdentity = (
  service: PlanningIdentityService,
): Effect.Effect<ToolIdentity, RunContractError> => Effect.try({
  try: () => {
    const refresh = verifiedIdentities.get(service)
    if (refresh === undefined) {
      throw invalidArtifact("The installed tool identity was not derived from verified artifact bytes.")
    }
    return refresh()
  },
  catch: (error) => error instanceof RunContractError
    ? error
    : invalidArtifact("The installed tool artifact could not be reverified."),
})
