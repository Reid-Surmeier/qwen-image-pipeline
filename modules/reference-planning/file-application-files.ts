import { constants as fsConstants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

import { Effect } from "effect"

import { ApplicationReadError } from "./errors.js"
import type { ApplicationFilesService } from "./types.js"

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

const readFailure = (applicationPath: string, error: unknown): ApplicationReadError => {
  if (error instanceof ApplicationReadError) return error
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return new ApplicationReadError("APPLICATION_PATH_MISSING", applicationPath)
  }
  if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
    return new ApplicationReadError("APPLICATION_PATH_UNSAFE", applicationPath)
  }
  return new ApplicationReadError("APPLICATION_READ_FAILED", applicationPath)
}

export const fileApplicationFiles = (
  applicationRoot: string,
): Effect.Effect<ApplicationFilesService, ApplicationReadError> => Effect.tryPromise({
  try: async () => {
    if (!isAbsolute(applicationRoot)) {
      throw new ApplicationReadError("APPLICATION_PATH_UNSAFE", applicationRoot)
    }
    const rootMetadata = await lstat(applicationRoot)
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new ApplicationReadError("APPLICATION_PATH_UNSAFE", applicationRoot)
    }
    const verifiedRoot = await realpath(resolve(applicationRoot))
    const verifiedRootMetadata = await lstat(verifiedRoot)
    return {
      read: (applicationPath) => Effect.tryPromise({
        try: async () => {
          if (!safeRelative(applicationPath)) {
            throw new ApplicationReadError("APPLICATION_PATH_UNSAFE", applicationPath)
          }
          const rootHandle = await open(
            verifiedRoot,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          )
          const openedDirectories: Array<Awaited<ReturnType<typeof open>>> = []
          try {
            const currentRootMetadata = await rootHandle.stat()
            if (
              currentRootMetadata.dev !== verifiedRootMetadata.dev ||
              currentRootMetadata.ino !== verifiedRootMetadata.ino
            ) {
              throw new ApplicationReadError("APPLICATION_PATH_UNSAFE", applicationPath)
            }
            let parentFd = rootHandle.fd
            const parts = applicationPath.split("/")
            for (const part of parts.slice(0, -1)) {
              const directoryHandle = await open(
                `/proc/self/fd/${parentFd}/${part}`,
                fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
              )
              openedDirectories.push(directoryHandle)
              parentFd = directoryHandle.fd
            }
            const handle = await open(
              `/proc/self/fd/${parentFd}/${parts.at(-1)!}`,
              fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
            )
            try {
              const metadata = await handle.stat()
              const actual = await realpath(`/proc/self/fd/${handle.fd}`)
              if (!metadata.isFile() || !inside(verifiedRoot, actual)) {
                throw new ApplicationReadError("APPLICATION_PATH_UNSAFE", applicationPath)
              }
              return { applicationPath, bytes: await handle.readFile() }
            } finally {
              await handle.close()
            }
          } finally {
            for (const directoryHandle of openedDirectories.reverse()) await directoryHandle.close()
            await rootHandle.close()
          }
        },
        catch: (error) => readFailure(applicationPath, error),
      }),
    } satisfies ApplicationFilesService
  },
  catch: (error) => readFailure(applicationRoot, error),
})
