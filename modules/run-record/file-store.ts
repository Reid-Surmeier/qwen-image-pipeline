import { randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { Effect, Layer } from "effect"

import { RunRecordError } from "./errors.js"
import { RunRecordStore } from "./types.js"
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

const durabilityError = (message: string): RunRecordError =>
  new RunRecordError("DURABILITY_FAILURE", message)

const attempt = <Value>(message: string, operation: () => Promise<Value>): Effect.Effect<Value, RunRecordError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => error instanceof RunRecordError ? error : durabilityError(message),
  })

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

const ensureDirectoryTree = async (root: string, applicationPath: string): Promise<string> => {
  let current = root
  for (const part of applicationPath.split("/").filter((value) => value.length > 0)) {
    current = join(current, part)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw durabilityError("A Run Record directory component is not a real directory.")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await mkdir(current, { mode: 0o700 })
    }
    const actual = await realpath(current)
    if (!inside(root, actual)) throw durabilityError("A Run Record directory escapes the application repository.")
  }
  return current
}

const atomicReplace = async (directory: string, name: string, body: Uint8Array): Promise<void> => {
  const staging = join(directory, `.${name}.${randomUUID()}.next`)
  try {
    await writeExclusive(staging, body)
    await rename(staging, join(directory, name))
    await syncDirectory(directory)
  } finally {
    await unlink(staging).catch(() => undefined)
  }
}

const collectEvidence = async (
  directory: string,
  prefix = "",
): Promise<Record<string, Uint8Array>> => {
  const result: Record<string, Uint8Array> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["request.json", "events.jsonl", "state.json"].includes(entry.name)) continue
    if (entry.isSymbolicLink()) throw durabilityError("Run evidence contains a symbolic link.")
    const applicationPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      Object.assign(result, await collectEvidence(absolute, applicationPath))
    } else if (entry.isFile()) {
      result[applicationPath] = await readFile(absolute)
    } else {
      throw durabilityError("Run evidence contains an unsupported filesystem entry.")
    }
  }
  return result
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

const acquireAppendLock = async (path: string): Promise<void> => {
  const body = Buffer.from(JSON.stringify({ pid: process.pid }), "utf8")
  for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
    try {
      await writeExclusive(path, body)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let ownerPid: number | undefined
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }
        if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) ownerPid = parsed.pid
      } catch {
        ownerPid = undefined
      }
      if (ownerPid !== undefined && processIsAlive(ownerPid)) {
        throw new RunRecordError("IDEMPOTENCY_CONFLICT", "Another process owns the Run event append lock.")
      }
      await unlink(path).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError
      })
    }
  }
  throw durabilityError("The Run event append lock could not be acquired.")
}

const buildFileRunRecordStore = (
  applicationRoot: string,
  artifactRoot: string,
): Effect.Effect<RunRecordStoreService, RunRecordError> => attempt(
  "The Run Record filesystem could not be initialized.",
  async () => {
    if (!isAbsolute(applicationRoot) || !safeRelative(artifactRoot)) {
      throw durabilityError("Run Record roots must be an absolute application root and a safe application-relative artifact root.")
    }
    const verifiedApplicationRoot = await realpath(resolve(applicationRoot))
    const runsRoot = await ensureDirectoryTree(verifiedApplicationRoot, `${artifactRoot}/runs`)
    const verifiedRunsRoot = await realpath(runsRoot)
    if (!inside(verifiedApplicationRoot, verifiedRunsRoot)) {
      throw durabilityError("The Run Record root escapes the application repository.")
    }

    const runDirectory = async (runId: string): Promise<string> => {
      if (!/^run-[a-f0-9]{24}$/.test(runId)) throw new RunRecordError("RUN_NOT_FOUND", "The Run identity is invalid.")
      const target = join(verifiedRunsRoot, runId)
      const metadata = await lstat(target)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw durabilityError("The Run directory is not a real directory.")
      const actual = await realpath(target)
      if (!inside(verifiedRunsRoot, actual)) throw durabilityError("The Run directory escapes the artifact root.")
      return actual
    }

    const service: RunRecordStoreService = {
      create: (runId, request, firstEvent, stateBody) => attempt(
        "The Run reservation could not be made durable.",
        async () => {
          if (!/^run-[a-f0-9]{24}$/.test(runId)) throw durabilityError("The Run identity is invalid.")
          const target = join(verifiedRunsRoot, runId)
          try {
            await lstat(target)
            throw new RunRecordError("RUN_ID_CONFLICT", `${runId} already exists.`)
          } catch (error) {
            if (error instanceof RunRecordError) throw error
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
          const staging = join(verifiedRunsRoot, `.${runId}.${randomUUID()}.creating`)
          await mkdir(staging, { mode: 0o700 })
          try {
            await writeExclusive(join(staging, "request.json"), request)
            await writeExclusive(join(staging, "events.jsonl"), firstEvent)
            await writeExclusive(join(staging, "state.json"), stateBody)
            await mkdir(join(staging, "outputs"), { mode: 0o700 })
            await syncDirectory(staging)
            await rename(staging, target)
            await syncDirectory(verifiedRunsRoot)
          } catch (error) {
            await rm(staging, { recursive: true, force: true })
            throw error
          }
        },
      ),
      read: (runId) => attempt("The Run Record could not be read.", async () => {
        try {
          const directory = await runDirectory(runId)
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
          const directory = await runDirectory(runId)
          const lockPath = join(directory, ".append.lock")
          await acquireAppendLock(lockPath)
          try {
            const journalPath = join(directory, "events.jsonl")
            const journal = await readFile(journalPath)
            const raw = Buffer.from(journal).toString("utf8")
            if (!raw.endsWith("\n")) throw new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal has an incomplete frame.")
            const lines = raw.slice(0, -1).split("\n")
            const head = JSON.parse(lines.at(-1) ?? "null") as { eventSha256?: unknown } | null
            if (head?.eventSha256 !== expectedHeadSha256) {
              throw new RunRecordError("IDEMPOTENCY_CONFLICT", "The event head changed before append.")
            }
            await atomicReplace(directory, "events.jsonl", Buffer.concat([journal, event]))
          } finally {
            await unlink(lockPath).catch(() => undefined)
          }
        },
      ),
      writeEvidence: (runId, applicationPath, body) => attempt(
        "Run evidence could not be made durable.",
        async () => {
          if (!safeRelative(applicationPath)) throw new RunRecordError("EVIDENCE_REWRITE", "The evidence destination is unsafe.")
          const directory = await runDirectory(runId)
          const parentPath = dirname(applicationPath)
          const parent = parentPath === "." ? directory : await ensureDirectoryTree(directory, parentPath)
          const destination = resolve(directory, applicationPath)
          if (!inside(directory, destination)) throw new RunRecordError("EVIDENCE_REWRITE", "The evidence destination escapes the Run.")
          try {
            await writeExclusive(destination, body)
            await syncDirectory(parent)
            return "created" as const
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
            const metadata = await lstat(destination)
            if (metadata.isSymbolicLink() || !metadata.isFile()) {
              throw new RunRecordError("EVIDENCE_REWRITE", `${applicationPath} is not a regular write-once file.`)
            }
            const existing = await readFile(destination)
            if (!Buffer.from(existing).equals(Buffer.from(body))) {
              throw new RunRecordError("EVIDENCE_REWRITE", `${applicationPath} is write-once.`)
            }
            return "same" as const
          }
        },
      ),
      writeState: (runId, stateBody) => attempt("The derived Run view could not be made durable.", async () => {
        const directory = await runDirectory(runId)
        await atomicReplace(directory, "state.json", stateBody)
      }),
    }
    return service
  },
)

export const fileRunRecordLayer = (
  applicationRoot: string,
  artifactRoot: string,
): Layer.Layer<RunRecordStoreService, RunRecordError> =>
  Layer.effect(RunRecordStore, buildFileRunRecordStore(applicationRoot, artifactRoot))
