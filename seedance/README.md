# Seedance Icon Animation Pipeline (addon)

An evidence-first environment for turning icons, favicons, marks, and first/last-frame
storyboards into style-locked motion with OpenRouter and ByteDance Seedance.

## Addon boundary

This directory retains the Seedance provider client and compatibility utilities used by
the repository-owned animation adapter.

- **Execution**: new paid submissions enter through `image-pipeline animation`, Conductor,
  and the application-owned Run Record. `seedance-icons submit` is retained only to issue
  a deterministic retirement refusal before provider access.
- **Paid policy**: the core repo's ADR 0003 allowance (`qwen/qwen-image-3-pro` image
  verification) does not cover this addon, and this addon does not extend it. Seedance
  video runs are governed by their own explicit cost gate (`docs/run-contract.md` here):
  exact application budget, one durable submission permit, and one provider job identity.
- **Skills**: agent skills live in `seedance/skills/` (not `.agents/skills/`, whose
  `to-spec` name is already taken by the locked skill set). Read them directly:
  `seedance/skills/to-spec/SKILL.md` is the entry point for spec-driven iteration.
- **Working here**: `python -m venv .venv && .venv/bin/pip install -e '.[dev]'` from
  `seedance/`, then `python -m pytest`, `ruff check .`, `python scripts/validate_repo.py`.
  All relative paths in the addon's docs are relative to `seedance/`.

This addon deliberately separates fast studies from final renders:

| Route | Default use | Live duration range* | Why |
| --- | --- | --- | --- |
| `bytedance/seedance-2.0-mini` | Studies and prompt iteration | 4–15 s | Faster, lower-cost exploration |
| `bytedance/seedance-2.5` | Finals and longer/richer reference work | 4–30 s | Higher-fidelity final route |

\*Never trust this table alone. `seedance-icons capabilities` captures the current OpenRouter
profile before a paid request. The exact canonical model version is stored with each run.

## What is different here

- The pipeline is for icon motion, not general video generation.
- Source geometry, silhouette, stroke, palette, negative space, typography, camera, matte,
  timing, easing, loop seam, and forbidden drift are first-class brief fields.
- Every run is additive and records its brief, compiled prompt, live capability profile,
  exact request hash, estimated cost, job state, output hash, and verification evidence.
- Planning and capability research are free. Paid submission requires an exact cost
  acknowledgement after human approval.
- Machine checks do not equal style approval. Final acceptance remains a focused visual review.

## Quick start

```bash
python -m venv .venv
.venv/bin/pip install -e '.[dev]'

seedance-icons capabilities --output capabilities.json
seedance-icons plan templates/favicon-loop.json \
  --model study --duration 6 --size 720x720 \
  --first-frame path/to/favicon.png --last-frame path/to/favicon.png \
  --slug favicon-loop --capabilities capabilities.json
```

The retained plan command prints an estimated upper-level request cost from OpenRouter's live
video-token metadata. It does **not** submit. New execution uses an application Project Contract,
Tool Lock, and Objective:

```bash
image-pipeline animation --application /path/to/application --objective objectives/animation.json
image-pipeline animation --application /path/to/application --objective objectives/animation.json \
  --execute --acknowledge-cost <exact-planned-USD>

# Existing recorded jobs only:
seedance-icons wait runs/<run>
seedance-icons verify runs/<run> --loop --first-anchor path/to/favicon.png
```

Repeating the public command resumes the same hash-identified Run and never obtains another
Submission Permit. An image-only Objective needs exactly `first-frame` and `last-frame` references
with the same closed `inferred-motion/v1` authority reason; the record must name provenance,
behavior, timing, spatial permissions, cancel/restart behavior, and `historicalFidelity: false`.

`OPENROUTER_API_KEY` is read only for submit/poll/download. Do not commit it. See
[the run contract](docs/run-contract.md), [model routing](docs/model-routing.md), and
[verification guide](docs/verification.md) before generating.

## Input modes

- Text-to-motion: prompt alone; useful only when exact source identity is not required.
- First-frame: preserve an icon as the opening state.
- First/last-frame: constrain a transition or attempt a loop.
- Reference motion: image, video, or audio references guide a separate run.
- Experimental mixed mode: anchor frames plus references. OpenRouter documents frame images as
  taking precedence, so this is rejected unless explicitly enabled and recorded as uncertain.

Native alpha video is not promised. Use a locked solid matte suitable for later keying, verify
edge contamination, and keep the transparent source asset as authority.

## Repository map

- `src/seedance_icons/` — capability checks, prompt compiler, OpenRouter client, run state, QA
- `comfyui_custom_nodes/` — cost-gated ComfyUI nodes that build plans rather than hiding paid work
- `workflows/` — ComfyUI API/MCP templates
- `skills/` — agent procedures for research, animation, spec iteration, and independent verification
- `templates/` — favicon loop, transition, and reference-motion briefs
- `docs/research/` — motion-variable and experiment guidance
- `runs/` — ignored, additive generated evidence

## Scope and provenance

This is an independent video-focused successor to the source-locked design philosophy in
`ReidSurmeier/graphic-design-image-pipeline` at commit
`2a890169e6f2293676d06f2c1bdb6e8b67978de3`. It does not use Qwen. It preserves the useful
Figma/ComfyUI principles: source authority, non-destructive variants, visible provenance,
focused readback, and explicit acceptance gates.
