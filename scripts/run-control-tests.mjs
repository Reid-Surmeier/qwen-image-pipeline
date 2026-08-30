#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import ts from "typescript"

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const outputDirectory = mkdtempSync(join(repository, ".control-tests-"))
const findTests = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) return findTests(absolute)
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [absolute] : []
  })

const entries = findTests(join(repository, "modules"))
  .map((entry) => entry.slice(repository.length + 1))
  .sort()

process.on("exit", () => rmSync(outputDirectory, { recursive: true, force: true }))

const configPath = join(repository, "tsconfig.json")
const config = ts.parseConfigFileTextToJson(
  configPath,
  readFileSync(configPath, "utf8"),
)
if (config.error !== undefined) {
  console.error(ts.formatDiagnosticsWithColorAndContext([config.error], {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => repository,
    getNewLine: () => "\n",
  }))
  process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repository)
const program = ts.createProgram({
  rootNames: entries.map((entry) => join(repository, entry)),
  options: {
    ...parsed.options,
    allowImportingTsExtensions: false,
    noEmit: false,
    outDir: outputDirectory,
    rootDir: repository,
    sourceMap: false,
  },
})
const emitted = program.emit()
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .concat(emitted.diagnostics)
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
if (diagnostics.length > 0 || emitted.emitSkipped) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => repository,
    getNewLine: () => "\n",
  }))
  process.exit(1)
}

for (const entry of entries) {
  const compiled = join(outputDirectory, entry.replace(/\.ts$/, ".js"))
  await import(pathToFileURL(compiled).href)
}
