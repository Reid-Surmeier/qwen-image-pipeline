# Plan from an application repository

An application agent uses one operation: `Conductor.plan({ objectivePath })`. Planning is local and no-cost. It either returns a deeply immutable Planned Run or a classified refusal; both answers include the objective, evidence, next action, spend risk, and remaining human decision. The production services are created from two explicit locations: `fileApplicationFiles(applicationRoot)` for application-owned inputs and `filePlanningIdentity(installedToolArtifactRoot)` for the installed, verified tool artifact.

## Fixed application files

The Conductor reads these files directly from the application root. It does not search Issues, experiment scripts, Markdown narration, parent directories, or environment overrides.

```text
.qwen-pipeline/project-contract.json
.qwen-pipeline/tool-lock.json
objectives/<objective>.json
references/<application-owned media>
```

The Project Contract identifies the application, safe reference/output roots, count and USD ceilings, and allowed Procedures. Each Procedure pins its mode, OpenRouter model, unit cost, reference requirements, and exact provider-payload JSON Pointer.

The installed tool artifact contains a closed `tool-artifact.json` inventory plus `RELEASE`, `COMMIT`, and `VERSION_PROFILE.json`. Planning verifies the complete inventory and hashes before deriving identity. The Tool Lock must exactly match that derived release, commit, aggregate artifact SHA-256, Procedure version, Run schema version, and adapter protocol version. Advancement re-reads the current Tool Lock and repeats the same match against both the immutable Planned Run and verified installed identity before it can reserve an attempt. A caller-provided identity, partial match, floating match, post-plan drift, unlisted file, or changed artifact is refused.

The Objective names one allowed Procedure and records each reference's application-relative path, SHA-256, kind, authority reason, declared media properties, and locked provider-payload destination. Credential values never belong in any of these files; only a later execution stage may resolve the logical OpenRouter credential name.

## Planning order

1. Verify the installed tool artifact and derive its exact identity.
2. Read the fixed Project Contract, Tool Lock, then Objective from the application root.
3. Reject secrets, unsafe paths, tool drift, unapproved Procedures, count excess, or budget excess.
4. Read each reference once, hash those bytes, detect its kind, inspect those same bytes, and compare declared properties and provider-payload destination.
5. Canonicalize, hash, and recursively freeze the Planned Run; Seedance video must already be bound to `/input_references/0/video_url/url`.

To upgrade one application, install and verify the new tool artifact, update only that application's Tool Lock to the derived identity, and rerun this no-cost planning procedure. Other application repositories remain pinned. Existing Run Records are replayed under the Procedure, Run schema, and adapter protocol recorded in each immutable request; they are never rewritten into the current schema.

A Planned Run is evidence, not an attempt. Planning cannot call Generation, resolve a credential, reserve an attempt, write a Run Record, or spend money.
