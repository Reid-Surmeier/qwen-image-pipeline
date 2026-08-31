import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

import { Effect, Layer } from "effect"

import { RunRecordError } from "./errors.js"
import { RunRecordStore } from "./types.js"
import type { RunRecordStoreService, StoredRunRecord } from "./types.js"

export type FileRunRecordFault =
  | "after-create"
  | "after-event-frame"
  | "after-evidence"
  | "after-state"

export type FileRunRecordHarness = Readonly<{
  layer: Layer.Layer<RunRecordStoreService, RunRecordError>
  failNext: (fault: FileRunRecordFault) => Effect.Effect<void>
}>

type FileFaultController = Readonly<{
  trip: (fault: FileRunRecordFault) => void
}>

const safeRelative = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith("~") &&
  !isAbsolute(value) &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !/^[A-Za-z]:/.test(value) &&
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
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const readRegularFile = async (path: string): Promise<Buffer> => {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw durabilityError("A Run Record control path is not a real file.")
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

type ApplicationOwnership = Readonly<{
  applicationId: string
  artifactRoot: string
}>

const readApplicationOwnership = async (applicationRoot: string): Promise<Readonly<{
  verifiedApplicationRoot: string
  verifiedApplicationRootIdentity: Readonly<{ dev: bigint | number; ino: bigint | number }>
  ownership: ApplicationOwnership
}>> => {
  if (!isAbsolute(applicationRoot)) {
    throw durabilityError("The application repository root must be absolute.")
  }
  const rootHandle = await open(
    applicationRoot,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  )
  let contractBytes: Buffer
  let verifiedApplicationRoot: string
  let verifiedApplicationRootIdentity: Readonly<{ dev: bigint | number; ino: bigint | number }>
  try {
    const rootMetadata = await rootHandle.stat()
    if (!rootMetadata.isDirectory()) {
      throw durabilityError("The application repository root must be a real directory.")
    }
    verifiedApplicationRoot = await realpath(`/proc/self/fd/${rootHandle.fd}`)
    verifiedApplicationRootIdentity = { dev: rootMetadata.dev, ino: rootMetadata.ino }
    const contractDirectoryHandle = await open(
      `/proc/self/fd/${rootHandle.fd}/.qwen-pipeline`,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
    try {
      const verifiedContractDirectory = await realpath(`/proc/self/fd/${contractDirectoryHandle.fd}`)
      if (!inside(verifiedApplicationRoot, verifiedContractDirectory)) {
        throw durabilityError("The Project Contract directory escapes the application repository.")
      }
      contractBytes = await readRegularFile(`/proc/self/fd/${contractDirectoryHandle.fd}/project-contract.json`)
    } finally {
      await contractDirectoryHandle.close()
    }
  } finally {
    await rootHandle.close()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contractBytes.toString("utf8"))
  } catch {
    throw durabilityError("The Project Contract is not valid JSON.")
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw durabilityError("The Project Contract must be a JSON object.")
  }
  const contract = parsed as Readonly<Record<string, unknown>>
  if (
    typeof contract.applicationId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(contract.applicationId) ||
    typeof contract.artifactRoot !== "string" ||
    !safeRelative(contract.artifactRoot)
  ) {
    throw durabilityError("The Project Contract must declare a valid applicationId and safe artifactRoot.")
  }
  return {
    verifiedApplicationRoot,
    verifiedApplicationRootIdentity,
    ownership: {
      applicationId: contract.applicationId,
      artifactRoot: contract.artifactRoot,
    },
  }
}

const withDirectoryTree = async <Value>(
  root: string,
  applicationPath: string,
  action: (anchoredDirectory: string) => Promise<Value>,
  expectedRootIdentity?: Readonly<{ dev: bigint | number; ino: bigint | number }>,
): Promise<Value> => {
  const rootHandle = await open(
    root,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      (root.startsWith("/proc/self/fd/") ? 0 : fsConstants.O_NOFOLLOW),
  )
  const handles = [rootHandle]
  try {
    const rootMetadata = await rootHandle.stat()
    if (
      expectedRootIdentity !== undefined &&
      (rootMetadata.dev !== expectedRootIdentity.dev || rootMetadata.ino !== expectedRootIdentity.ino)
    ) {
      throw durabilityError("The supplied root no longer names the verified directory.")
    }
    const verifiedRoot = await realpath(`/proc/self/fd/${rootHandle.fd}`)
    let parentHandle = rootHandle
    for (const part of applicationPath.split("/").filter((value) => value.length > 0 && value !== ".")) {
      const childPath = `/proc/self/fd/${parentHandle.fd}/${part}`
      let childHandle: Awaited<ReturnType<typeof open>>
      try {
        childHandle = await open(
          childPath,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        try {
          await mkdir(childPath, { mode: 0o700 })
          await syncDirectory(`/proc/self/fd/${parentHandle.fd}`)
        } catch (createError) {
          if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError
        }
        childHandle = await open(
          childPath,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        )
      }
      handles.push(childHandle)
      const actual = await realpath(`/proc/self/fd/${childHandle.fd}`)
      if (!inside(verifiedRoot, actual)) {
        throw durabilityError("A Run Record directory escapes its verified root.")
      }
      parentHandle = childHandle
    }
    return await action(`/proc/self/fd/${parentHandle.fd}`)
  } finally {
    for (const handle of handles.reverse()) await handle.close()
  }
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
  verifiedRoot?: string,
): Promise<Record<string, Uint8Array>> => {
  const result: Record<string, Uint8Array> = {}
  const directoryHandle = await open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
  )
  try {
    const anchoredDirectory = `/proc/self/fd/${directoryHandle.fd}`
    const root = verifiedRoot ?? await realpath(anchoredDirectory)
    for (const entry of await readdir(anchoredDirectory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["request.json", "events.jsonl", "state.json"].includes(entry.name)) continue
      const applicationPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      const handle = await open(
        `${anchoredDirectory}/${entry.name}`,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      )
      try {
        const metadata = await handle.stat()
        const actual = await realpath(`/proc/self/fd/${handle.fd}`)
        if (!inside(root, actual)) throw durabilityError("Run evidence escapes the verified Run directory.")
        if (metadata.isDirectory()) {
          Object.assign(result, await collectEvidence(`/proc/self/fd/${handle.fd}`, applicationPath, root))
        } else if (metadata.isFile()) {
          result[applicationPath] = await handle.readFile()
        } else {
          throw durabilityError("Run evidence contains an unsupported filesystem entry.")
        }
      } finally {
        await handle.close()
      }
    }
  } finally {
    await directoryHandle.close()
  }
  return result
}

const buildFileRunRecordStore = (
  applicationRoot: string,
  faults?: FileFaultController,
): Effect.Effect<RunRecordStoreService, RunRecordError> => attempt(
  "The Run Record filesystem could not be initialized.",
  async () => {
    const { verifiedApplicationRoot, verifiedApplicationRootIdentity, ownership } = await readApplicationOwnership(applicationRoot)
    const verifiedRunsRoot = await withDirectoryTree(
      verifiedApplicationRoot,
      `${ownership.artifactRoot}/runs`,
      (anchoredRunsRoot) => realpath(anchoredRunsRoot),
      verifiedApplicationRootIdentity,
    )
    if (!inside(verifiedApplicationRoot, verifiedRunsRoot)) {
      throw durabilityError("The Run Record root escapes the application repository.")
    }
    const verifiedRunsMetadata = await lstat(verifiedRunsRoot)

    const withRunsRoot = async <Value>(action: (directory: string) => Promise<Value>): Promise<Value> => {
      const declaredMetadata = await lstat(verifiedRunsRoot)
      if (declaredMetadata.isSymbolicLink() || !declaredMetadata.isDirectory()) {
        throw durabilityError("The declared Run Record root was replaced.")
      }
      const handle = await open(
        verifiedRunsRoot,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      )
      try {
        const currentMetadata = await handle.stat()
        const anchoredRunsRoot = `/proc/self/fd/${handle.fd}`
        const [declared, anchored] = await Promise.all([
          realpath(verifiedRunsRoot),
          realpath(anchoredRunsRoot),
        ])
        if (
          currentMetadata.dev !== verifiedRunsMetadata.dev ||
          currentMetadata.ino !== verifiedRunsMetadata.ino ||
          declared !== anchored ||
          !inside(verifiedApplicationRoot, anchored)
        ) {
          throw durabilityError("The declared Run Record root no longer names the verified application directory.")
        }
        return await action(anchoredRunsRoot)
      } finally {
        await handle.close()
      }
    }

    const withRunDirectory = async <Value>(
      runId: string,
      action: (directory: string) => Promise<Value>,
    ): Promise<Value> => {
      if (!/^run-[a-f0-9]{24}$/.test(runId)) throw new RunRecordError("RUN_NOT_FOUND", "The Run identity is invalid.")
      return withRunsRoot(async (anchoredRunsRoot) => {
        const handle = await open(
          join(anchoredRunsRoot, runId),
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        )
        try {
          const anchoredDirectory = `/proc/self/fd/${handle.fd}`
          const actual = await realpath(anchoredDirectory)
          if (!inside(verifiedApplicationRoot, actual)) throw durabilityError("The Run directory escapes the application repository.")
          return await action(anchoredDirectory)
        } finally {
          await handle.close()
        }
      })
    }

    const materializeJournal = async (directory: string): Promise<Buffer> => {
      let journal = await readRegularFile(join(directory, "events.jsonl"))
      return withDirectoryTree(directory, ".event-frames", async (framesDirectory) => {
        while (true) {
          const raw = journal.toString("utf8")
          if (!raw.endsWith("\n")) {
            throw new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal has an incomplete frame.")
          }
          const lines = raw.slice(0, -1).split("\n")
          const head = JSON.parse(lines.at(-1) ?? "null") as { eventSha256?: unknown } | null
          if (typeof head?.eventSha256 !== "string" || !/^[a-f0-9]{64}$/.test(head.eventSha256)) {
            throw new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal head is invalid.")
          }
          const framePath = join(framesDirectory, `${head.eventSha256}.jsonl`)
          let nextFrame: Buffer
          try {
            nextFrame = await readRegularFile(framePath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return journal
            throw error
          }
          let next: { previousEventSha256?: unknown }
          try {
            next = JSON.parse(nextFrame.toString("utf8").trimEnd()) as { previousEventSha256?: unknown }
          } catch {
            throw new RunRecordError("EVENT_CHAIN_BROKEN", "An immutable event frame is invalid JSON.")
          }
          if (!nextFrame.toString("utf8").endsWith("\n") || next.previousEventSha256 !== head.eventSha256) {
            throw new RunRecordError("EVENT_CHAIN_BROKEN", "An immutable event frame does not extend the journal head.")
          }
          journal = Buffer.concat([journal, nextFrame])
          await atomicReplace(directory, "events.jsonl", journal)
        }
      })
    }

    const service: RunRecordStoreService = {
      create: (runId, request, firstEvent, stateBody) => attempt(
        "The Run reservation could not be made durable.",
        async () => {
          if (!/^run-[a-f0-9]{24}$/.test(runId)) throw durabilityError("The Run identity is invalid.")
          let requestDocument: unknown
          try {
            requestDocument = JSON.parse(Buffer.from(request).toString("utf8"))
          } catch {
            throw new RunRecordError("APPLICATION_OWNERSHIP_MISMATCH", "The Run Request cannot establish application ownership.")
          }
          if (
            requestDocument === null ||
            typeof requestDocument !== "object" ||
            Array.isArray(requestDocument) ||
            (requestDocument as Readonly<Record<string, unknown>>).applicationId !== ownership.applicationId ||
            (requestDocument as Readonly<Record<string, unknown>>).artifactRoot !== ownership.artifactRoot
          ) {
            throw new RunRecordError("APPLICATION_OWNERSHIP_MISMATCH", "The Run Request does not match the application Project Contract.")
          }
          return withRunsRoot(async (anchoredRunsRoot) => {
            const target = join(anchoredRunsRoot, runId)
            try {
              await lstat(target)
              throw new RunRecordError("RUN_ID_CONFLICT", `${runId} already exists.`)
            } catch (error) {
              if (error instanceof RunRecordError) throw error
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
            const staging = join(anchoredRunsRoot, `.${runId}.${randomUUID()}.creating`)
            await mkdir(staging, { mode: 0o700 })
            try {
              const stagingHandle = await open(
                staging,
                fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
              )
              try {
                const anchoredStaging = `/proc/self/fd/${stagingHandle.fd}`
                await writeExclusive(join(anchoredStaging, "request.json"), request)
                await writeExclusive(join(anchoredStaging, "events.jsonl"), firstEvent)
                await writeExclusive(join(anchoredStaging, "state.json"), stateBody)
                await mkdir(join(anchoredStaging, "outputs"), { mode: 0o700 })
                await mkdir(join(anchoredStaging, ".event-frames"), { mode: 0o700 })
                await syncDirectory(anchoredStaging)
                if (await realpath(staging) !== await realpath(anchoredStaging)) {
                  throw durabilityError("The Run reservation staging directory was replaced.")
                }
                await rename(staging, target)
                await syncDirectory(anchoredRunsRoot)
                faults?.trip("after-create")
              } finally {
                await stagingHandle.close()
              }
            } catch (error) {
              await rm(staging, { recursive: true, force: true })
              throw error
            }
          })
        },
      ),
      read: (runId) => attempt("The Run Record could not be read.", async () => {
        try {
          return await withRunDirectory(runId, async (directory) => {
            await materializeJournal(directory)
            const request = await readRegularFile(join(directory, "request.json"))
            const events = await readRegularFile(join(directory, "events.jsonl"))
            let state: Uint8Array | undefined
            try {
              state = await readRegularFile(join(directory, "state.json"))
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
            return {
              request,
              events,
              evidence: await collectEvidence(directory, "", await realpath(directory)),
              ...(state === undefined ? {} : { state }),
            } satisfies StoredRunRecord
          })
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
          await withRunDirectory(runId, async (directory) => {
            const journal = await materializeJournal(directory)
            const raw = journal.toString("utf8")
            const lines = raw.slice(0, -1).split("\n")
            const head = JSON.parse(lines.at(-1) ?? "null") as { eventSha256?: unknown } | null
            if (head?.eventSha256 !== expectedHeadSha256) {
              throw new RunRecordError("IDEMPOTENCY_CONFLICT", "The event head changed before append.")
            }
            let proposed: { previousEventSha256?: unknown }
            try {
              proposed = JSON.parse(Buffer.from(event).toString("utf8").trimEnd()) as { previousEventSha256?: unknown }
            } catch {
              throw new RunRecordError("EVENT_CHAIN_BROKEN", "The proposed event frame is invalid JSON.")
            }
            if (!Buffer.from(event).toString("utf8").endsWith("\n") || proposed.previousEventSha256 !== expectedHeadSha256) {
              throw new RunRecordError("EVENT_CHAIN_BROKEN", "The proposed event does not extend the expected journal head.")
            }
            await withDirectoryTree(directory, ".event-frames", async (framesDirectory) => {
              const framePath = join(framesDirectory, `${expectedHeadSha256}.jsonl`)
              const candidatePath = join(framesDirectory, `.${expectedHeadSha256}.${randomUUID()}.candidate`)
              await writeExclusive(candidatePath, event)
              try {
                try {
                  await link(candidatePath, framePath)
                  await syncDirectory(framesDirectory)
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
                  const existing = await readRegularFile(framePath)
                  if (!existing.equals(Buffer.from(event))) {
                    throw new RunRecordError("IDEMPOTENCY_CONFLICT", "A different event already extends the expected journal head.")
                  }
                }
              } finally {
                await unlink(candidatePath).catch(() => undefined)
              }
            })
            faults?.trip("after-event-frame")
            await materializeJournal(directory)
          })
        },
      ),
      writeEvidence: (runId, applicationPath, body) => attempt(
        "Run evidence could not be made durable.",
        async () => {
          if (!safeRelative(applicationPath)) throw new RunRecordError("EVIDENCE_REWRITE", "The evidence destination is unsafe.")
          return await withRunDirectory(runId, async (directory) => {
            const parentPath = dirname(applicationPath)
            return withDirectoryTree(directory, parentPath, async (parent) => {
              const destination = join(parent, applicationPath.split("/").at(-1)!)
              try {
                await writeExclusive(destination, body)
                await syncDirectory(parent)
                faults?.trip("after-evidence")
                return "created" as const
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
                const metadata = await lstat(destination)
                if (metadata.isSymbolicLink() || !metadata.isFile()) {
                  throw new RunRecordError("EVIDENCE_REWRITE", `${applicationPath} is not a regular write-once file.`)
                }
                const existing = await readRegularFile(destination)
                if (!Buffer.from(existing).equals(Buffer.from(body))) {
                  throw new RunRecordError("EVIDENCE_REWRITE", `${applicationPath} is write-once.`)
                }
                return "same" as const
              }
            })
          })
        },
      ),
      writeState: (runId, stateBody) => attempt("The derived Run view could not be made durable.", async () => {
        await withRunDirectory(runId, async (directory) => {
          await atomicReplace(directory, "state.json", stateBody)
          faults?.trip("after-state")
        })
      }),
    }
    return service
  },
)

export const fileRunRecordLayer = (
  applicationRoot: string,
): Effect.Effect<Layer.Layer<RunRecordStoreService, RunRecordError>> =>
  Effect.succeed(Layer.effect(RunRecordStore, buildFileRunRecordStore(applicationRoot)))

export const makeFileRunRecordHarness = (
  applicationRoot: string,
): Effect.Effect<FileRunRecordHarness> => Effect.sync(() => {
  let failing: FileRunRecordFault | undefined
  const faults: FileFaultController = {
    trip: (fault) => {
      if (failing !== fault) return
      failing = undefined
      throw durabilityError(`${fault} was interrupted.`)
    },
  }
  return {
    layer: Layer.effect(RunRecordStore, buildFileRunRecordStore(applicationRoot, faults)),
    failNext: (fault) => Effect.sync(() => { failing = fault }),
  }
})
