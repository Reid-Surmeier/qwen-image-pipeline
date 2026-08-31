# Migrate the inherited Qwen CLI

`qwen-ui-pipeline generate <brief.json>` remains readable as a compatibility
surface, but it performs no provider submission. It returns a version-1 JSON
migration record containing the saved Edit Brief and names the replacement:
`Conductor.plan` followed by `Conductor.advance`.

Move the saved intent into the application repository:

1. Put the objective in `objectives/<name>.json` and preserve the legacy text as
   its `summary`.
2. Declare the exact OpenRouter model, count ceiling, cost, resolution, aspect
   ratio, seed, and reference roles in `.qwen-pipeline/project-contract.json`.
3. Pin the installed tool, Procedure, Run schema, and adapter protocol in
   `.qwen-pipeline/tool-lock.json`.
4. Store each authoritative reference under an allowed application-owned
   reference root with its SHA-256 and exact payload destination.
5. Resolve `inheritedQwenPythonAdapter()` before reservation, then call
   `Conductor.plan({ objectivePath })` and provide that repository-owned service
   as Generation's adapter when calling `Conductor.advance`.

The version-1 adapter request is closed and contains the exact provider, model,
count, resolution, aspect ratio, seed, objective, and reference
role/path/hash/media/bytes/destination evidence.
The retained Python kernel accepts only OpenRouter, calls its injected client
once, normalizes PNG output into canonical RGBA evidence, and returns no Run
writer, Assembly, Verification, retry, or Approval authority. Provider
rejection after dispatch is conservatively ambiguous and must be reconciled;
the compatibility command never creates that state because it never submits.
