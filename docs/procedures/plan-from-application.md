# Plan from an application repository

An application agent uses one operation: `Conductor.plan({ objectivePath })`. Planning is local and no-cost. It either returns a deeply immutable Planned Run or a classified refusal; both answers include the objective, evidence, next action, spend risk, and remaining human decision.

## Fixed application files

The Conductor reads these files directly from the application root. It does not search Issues, experiment scripts, Markdown narration, parent directories, or environment overrides.

```text
.qwen-pipeline/project-contract.json
.qwen-pipeline/tool-lock.json
objectives/<objective>.json
references/<application-owned media>
```

The Project Contract identifies the application, safe reference/output roots, count and USD ceilings, and allowed Procedures. Each Procedure pins its mode, OpenRouter model, unit cost, reference requirements, and exact provider-payload JSON Pointer.

The Tool Lock must exactly match the installed tool identity: release, commit, artifact SHA-256, Procedure version, Run schema version, and adapter protocol version. A partial or floating match is refused.

The Objective names one allowed Procedure and records each reference's application-relative path, SHA-256, kind, authority reason, declared media properties, and locked provider-payload destination. Credential values never belong in any of these files; only a later execution stage may resolve the logical OpenRouter credential name.

## Planning order

1. Read the fixed Project Contract, Tool Lock, then Objective.
2. Reject secrets, unsafe paths, tool drift, unapproved Procedures, count excess, or budget excess.
3. Read each reference once, hash those bytes, detect its kind, inspect those same bytes, and compare declared properties.
4. Prove each reference targets the Procedure's exact provider-payload location; Seedance video requires video bytes at `/input_references/0/video_url/url`.
5. Canonicalize, hash, and recursively freeze the Planned Run.

A Planned Run is evidence, not an attempt. Planning cannot call Generation, resolve a credential, reserve an attempt, write a Run Record, or spend money.
