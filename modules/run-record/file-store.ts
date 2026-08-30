import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { Effect } from "effect"

import { RunRecordError } from "./errors.js"
import type { RunRecordStoreService, StoredRunRecord } from "./types.js"

const safeRelative = (value: string): boolean =>
  value.length > 0 &&
  !isAbsolute(value) &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const inside = (root: string, target: string): boolean => {
  const offset = relative(root, target)
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
}

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const writeExclusive = async (path: string, body: Uint8Array): Promise<void> => {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const writeReplace = async (path: string, body: Uint8Array): Promise<void> => {
  const handle = await open(path, "w", 0o600)
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const durabilityError = (message: string): RunRecordError =>
  new RunRecordError("DURABILITY_FAILURE", message)

const attempt = <Value>(message: string, operation: () => Promise<Value>): Effect.Effect<Value, RunRecordError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => error instanceof RunRecordError ? error : durabilityError(message),
  })

const collectEvidence = async (
  directory: string,
  prefix = "",
): Promise<Record<string, Uint8Array>> => {
  const result: Record<string, Uint8Array> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["request.json", "events.jsonl", "state.json"].includes(entry.name)) continue
    const applicationPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      Object.assign(result, await collectEvidence(absolute, applicationPath))
    } else if (entry.isFile()) {
      result[applicationPath] = await readFile(absolute)
    }
  }
  return result
}

export const makeFileRunRecordStore = (
  applicationRoot: string,
  artifactRoot: string,
): RunRecordStoreService => {
  if (!isAbsolute(applicationRoot) || !safeRelative(artifactRoot)) {
    throw new RunRecordError("DURABILITY_FAILURE", "Run Record roots must be an absolute application root and a safe application-relative artifact root.")
  }
  const verifiedApplicationRoot = resolve(applicationRoot)
  const runsRoot = resolve(verifiedApplicationRoot, artifactRoot, "runs")
  if (!inside(verifiedApplicationRoot, runsRoot)) {
    throw new RunRecordError("DURABILITY_FAILURE", "The Run Record root escapes the application repository.")
  }
  const runDirectory = (runId: string): string => resolve(runsRoot, runId)

  return {
    create: (runId, request, firstEvent, stateBody) => attempt(
      "The Run reservation could not be made durable.",
      async () => {
        await mkdir(runsRoot, { recursive: true, mode: 0o700 })
        const target = runDirectory(runId)
        const staging = resolve(runsRoot, `.${runId}.creating`)
        if (!inside(runsRoot, target) || !inside(runsRoot, staging)) throw durabilityError("The Run identity escaped its artifact root.")
        try {
          await stat(target)
          throw new RunRecordError("RUN_ID_CONFLICT", `${runId} already exists.`)
        } catch (error) {
          if (error instanceof RunRecordError) throw error
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        await rm(staging, { recursive: true, force: true })
        await mkdir(staging, { mode: 0o700 })
        try {
          await writeExclusive(join(staging, "request.json"), request)
          await writeExclusive(join(staging, "events.jsonl"), firstEvent)
          await writeExclusive(join(staging, "state.json"), stateBody)
          await mkdir(join(staging, "outputs"), { mode: 0o700 })
          await syncDirectory(staging)
          await rename(staging, target)
          await syncDirectory(runsRoot)
        } catch (error) {
          await rm(staging, { recursive: true, force: true })
          throw error
        }
      },
    ),
    read: (runId) => attempt("The Run Record could not be read.", async () => {
      const directory = runDirectory(runId)
      if (!inside(runsRoot, directory)) throw durabilityError("The Run identity escaped its artifact root.")
      try {
        const request = await readFile(join(directory, "request.json"))
        const events = await readFile(join(directory, "events.jsonl"))
        let state: Uint8Array | undefined
        try {
          state = await readFile(join(directory, "state.json"))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        return {
          request,
          events,
          evidence: await collectEvidence(directory),
          ...(state === undefined ? {} : { state }),
        } satisfies StoredRunRecord
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new RunRecordError("RUN_NOT_FOUND", `${runId} does not exist.`)
        }
        throw error
      }
    }),
    appendEvent: (runId, expectedHeadSha256, event) => attempt(
      "The Run event could not be made durable.",
      async () => {
        const directory = runDirectory(runId)
        const lockPath = join(directory, ".append.lock")
        const lock = await open(lockPath, "wx", 0o600)
        await lock.close()
        try {
          const journalPath = join(directory, "events.jsonl")
          const journal = await readFile(journalPath, "utf8")
          const lines = journal.trimEnd().split("\n")
          const head = JSON.parse(lines.at(-1) ?? "null") as { eventSha256?: unknown } | null
          if (head?.eventSha256 !== expectedHeadSha256) {
            throw new RunRecordError("IDEMPOTENCY_CONFLICT", "The event head changed before append.")
          }
          const handle = await open(journalPath, "a")
          try {
            await handle.writeFile(event)
            await handle.sync()
          } finally {
            await handle.close()
          }
          await syncDirectory(directory)
        } finally {
          await unlink(lockPath).catch(() => undefined)
        }
      },
    ),
    writeEvidence: (runId, applicationPath, body) => attempt(
      "Run evidence could not be made durable.",
      async () => {
        if (!safeRelative(applicationPath)) throw new RunRecordError("EVIDENCE_REWRITE", "The evidence destination is unsafe.")
        const directory = runDirectory(runId)
        const destination = resolve(directory, applicationPath)
        if (!inside(directory, destination)) throw new RunRecordError("EVIDENCE_REWRITE", "The evidence destination escapes the Run.")
        await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 })
        try {
          await writeExclusive(destination, body)
          await syncDirectory(resolve(destination, ".."))
          return "created" as const
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          const existing = await readFile(destination)
          if (!Buffer.from(existing).equals(Buffer.from(body))) {
            throw new RunRecordError("EVIDENCE_REWRITE", `${applicationPath} is write-once.`)
          }
          return "same" as const
        }
      },
    ),
    writeState: (runId, stateBody) => attempt("The derived Run view could not be made durable.", async () => {
      const directory = runDirectory(runId)
      const staging = join(directory, ".state.json.next")
      await writeReplace(staging, stateBody)
      await rename(staging, join(directory, "state.json"))
      await syncDirectory(directory)
    }),
  }
}
