#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import ts from "typescript"

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const outputDirectory = mkdtempSync(join(repository, ".control-tests-"))
const entries = [
  "modules/conductor/conductor.test.ts",
  "modules/reference-planning/reference-planning.test.ts",
  "modules/run-contract/run-contract.test.ts",
  "modules/run-record/run-record.test.ts",
  "modules/generation/generation.test.ts",
  "modules/assembly/assembly.test.ts",
  "modules/verification/verification.test.ts",
  "modules/learning-promotion/learning-promotion.test.ts",
]

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
