#!/usr/bin/env node
// Build one closed, hash-inventoried distribution. Does not tag or publish a release.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, renameSync, existsSync, lstatSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import ts from "typescript"
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = resolve(process.argv[2] ?? `.tool-builds/${Date.now()}`)
mkdirSync(output, { recursive: true })
if (readdirSync(output).length) throw new Error("Output must be empty; existing distributions are immutable.")
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (entry.isSymbolicLink()) throw new Error(`Symlink in tool input: ${entry.name}`)
  return entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]
})
const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const entries = walk(join(root, "modules")).filter(path => path.endsWith(".ts") && !path.endsWith(".test.ts"))
const program = ts.createProgram([...entries, join(root, "scripts/image-pipeline.ts")], {
  ...parsed.options, noEmit: false, allowImportingTsExtensions: false, outDir: output, rootDir: root, sourceMap: false,
})
const errors = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error)
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: n => n, getCurrentDirectory: () => root, getNewLine: () => "\n" }))
if (program.emit().emitSkipped) throw new Error("Tool compilation failed.")
for (const directory of ["qwen_ui_pipeline", "seedance/src", "procedures"]) cpSync(join(root, directory), join(output, directory), { recursive: true, filter: path => !path.includes("__pycache__") && !path.endsWith(".pyc") })
const copied = new Set()
const dependency = name => {
  if (copied.has(name)) return
  copied.add(name)
  const source = join(root, "node_modules", name)
  cpSync(source, join(output, "node_modules", name), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  for (const next of Object.keys(manifest.dependencies ?? {})) dependency(next)
}
dependency("effect")
writeFileSync(join(output, "package.json"), '{"type":"module"}\n')
writeFileSync(join(output, "COMMIT"), execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }))
writeFileSync(join(output, "RELEASE"), "v0.3.0\n")
writeFileSync(join(output, "VERSION_PROFILE.json"), '{"procedureVersion":"1","runSchemaVersion":"3","adapterProtocolVersion":"1"}\n')
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const files = walk(output).map(path => ({ path: path.slice(output.length + 1), sha256: hash(readFileSync(path)) })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
writeFileSync(join(output, "tool-artifact.json"), JSON.stringify({ schemaVersion: "1", files, artifactSha256: hash(JSON.stringify({ files })) }) + "\n")
const current = join(root, ".tool-current")
if (existsSync(current) && !lstatSync(current).isSymbolicLink()) throw new Error("Tool pointer is not a symlink; refusing to replace it.")
const temporary = `${current}-${process.pid}.tmp`
symlinkSync(output, temporary, "dir")
renameSync(temporary, current)
console.log(join(output, "scripts/image-pipeline.js"))
