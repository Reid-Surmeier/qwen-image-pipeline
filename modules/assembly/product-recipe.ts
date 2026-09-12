import { spawnSync } from "node:child_process"
import { Effect } from "effect"
import { AssemblyError } from "./errors.js"

export type ProductRecipeInput = Readonly<{ toolRoot: string; applicationRoot: string; recipePath: string }>
export type ProductRecipeResult = Readonly<{ reportPath: string; report: Readonly<{ paidCalls: 0; approval: "unverified"; records: ReadonlyArray<Readonly<Record<string, unknown>>>; checks: Readonly<Record<string, string>> }> }>

export const assembleProductRecipe = (input: ProductRecipeInput): Effect.Effect<ProductRecipeResult, AssemblyError> => Effect.try({
  try: () => {
    const child = spawnSync("/usr/bin/python3", ["-m", "qwen_ui_pipeline.muse_assembly_host", "--application", input.applicationRoot, "--recipe", input.recipePath], {
      cwd: input.toolRoot, env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    })
    if (child.status !== 0) throw new Error("Assembly did not complete")
    const result = JSON.parse(child.stdout)
    if (typeof result.reportPath !== "string" || result.report?.paidCalls !== 0 || result.report?.approval !== "unverified" || !Array.isArray(result.report.records)) throw new Error("Invalid Assembly report")
    return result
  },
  catch: () => new AssemblyError("ASSEMBLY_INPUT_HASH_MISMATCH", "Saved product Assembly failed; inspect the application's recipe and partial output evidence."),
})
