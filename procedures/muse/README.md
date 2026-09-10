# Saved Muse procedures

Muse (`meta/muse-image`, OpenRouter) is the image model. Seedance remains the icon-animation procedure in `seedance/`. This folder records the source of the port; project inputs and results stay in the application.

Build the tool once from this repository with `npm ci` and `node scripts/package-tool.mjs`. The latter creates an inventoried candidate distribution and updates `.tool-current`; it does not publish a release. Use `bin/image-pipeline` from any application checkout. `identity` prints the verified distribution identity. Python runtime dependencies are Pillow, NumPy and OpenCV; product Assembly also needs Tesseract and the application's exact fonts. Seedance retains its own documented dependencies.

## Ordinary creation and saved edits

Write the prompt and recipe inside the application. For ordinary creation:

```json
{
  "procedure": "image",
  "prompt": "image-work/prompt.txt",
  "promptSha256": "SHA256_OF_THE_EXACT_PROMPT_FILE",
  "size": "1760x1440",
  "references": []
}
```

Choose size for the intended framing; Muse does not promise exact output pixels or deterministic seeds. No advertising instructions are appended to ordinary images. For an existing general/UI edit, reuse its saved preflight file:

```json
{"procedure":"edit","plan":"image-work/generation-preflight.json","attempt":"005"}
```

A new edit plan uses the same complete enclosing shape (paths are application-relative):

```json
{"attempts":[{"id":"005","prompt":"image-work/edit-prompt.txt","promptSha256":"SHA256_OF_EXACT_PROMPT","size":"1760x1440","inputs":[{"path":"references/ui.png","sha256":"SHA256_OF_REFERENCE_BYTES"}]}]}
```

The saved attempt supplies `prompt`, `promptSha256`, `size` and ordered `inputs: [{path,sha256}]`; the original `input`/`inputSha256` single-image form also works. The original edit procedure uses PNG reference bytes. Keep any preprocessing required by that application's saved plan unchanged.

```bash
/path/to/Image-generation-pipline/bin/image-pipeline prepare --application /path/to/application --recipe image-work/recipe.json --unit-cost 0.01 --budget 0.01
/path/to/Image-generation-pipline/bin/image-pipeline image --application /path/to/application --objective .qwen-pipeline/muse-RECIPE_ID.json
```

Use the Objective path printed by `prepare`. Both commands above are unpaid. The example cost is a declared estimate, not a current price guarantee: select it from the application's authorized pre-submission record. Add `--execute` to `image` only when spending is authorized, running through the `access-bitwarden-secrets` runner with the logical `OPENROUTER_API_KEY`. Each Muse request is one output. The existing Run Record reserves before dispatch and never issues a second submission for the same run. Changed prompts/plans/recipes or references stop advancement.

For an existing application, the Tool Lock must match `identity`. A deliberate application upgrade changes that lock while retaining prior run records; `prepare` will not silently change it or raise an existing budget. The `.qwen-pipeline` configuration directory and normalized `application/vnd.qwen.rgba+json` media identifier are retained serialization compatibility names, not Qwen execution routes.

A generated image without an Assembly contract returns `image-review`: its pixels and actual/unknown cost are recorded, while visual acceptance and exact preservation remain unverified. A strict region-edit Objective can still declare the existing `assemblyPlan`, select its donor and use the existing Assembly, Verification and Review gates.

## DIS-photo composition and refinement

```json
{"procedure":"dis-composite","spec":"ad-work/spec.json"}
```

The existing spec supplies `prompt`, `size` and ordered `references`. Relative references resolve beside the spec; `dis:557` resolves against the application's `corpus/dis/images/557-*.jpg`. The original contents guard is appended only in this procedure. `noForbidContents: true` explicitly selects the original exception.

For the next pass, use the same recipe with `refineFrom` naming the previous application image. The preserved `refine_prompt` override or original `REFINE` text is sent with that image as its sole reference. Native PNG/JPEG/WebP types are decoded rather than inferred from filename extensions. Prepare and reserve each pass separately. A refinement is not an exact-preservation claim.

## Invented-product ads

The product engine and prompt construction are preserved source slices, not a new invention recipe:

```bash
/path/to/Image-generation-pipline/bin/image-pipeline product --application /path/to/application --output product-work --seed 3 --mode anti-solution --strategy catalog-pair
```

`product-work` must be new and its parent must exist. This unpaid command saves the packet, prompt and recipe. The six existing invention modes and four donor strategies remain in the preserved engine. Run `prepare` and `image` for the resulting recipe as above. Product donors use no DIS photos or source-ad image references.

Export a completed central product Run into the saved gallery input format, without another paid call:

```bash
/path/to/Image-generation-pipline/bin/image-pipeline export-donor --application /path/to/application --run RUN_ID --recipe product-work/recipe.json --output donor-work
```

The export verifies the original recipe/packet and Run evidence, preserves the true native image type and cost, and prints the input hashes for the application's Assembly recipe. `donor-work` must be new. It contains no approval. A saved recipe can choose this `donorHome` and retain its existing layouts, fonts and region settings.

The saved gallery's deterministic Assembly is callable with:

```bash
/path/to/Image-generation-pipline/bin/image-pipeline assemble --application /path/to/application --recipe ad-work/assembly-recipe.json
```

The application recipe contains `donorHome` (its packets, generation plan and reconciled attempt records), a new `outputHome`, `layouts`, `inputHashes`, `fontHashes`, and the original application `settings`: PRODUCT_REGIONS, PRODUCT_CLEANUP_REGIONS, OLD_LEADER_ERASE_REGIONS, OLD_LEADERS, BANNED, VARIANTS, KODAK_CATEGORIES, KODAK_CALLOUTS and KODAK_ANCHORS. These are the saved catalog recipe's layout data, not defaults for ordinary edits or claims of support for arbitrary new templates. Source layout, plan, packets, run records and source/donor images must all appear in `inputHashes`; exact font paths and hashes go in `fontHashes`.

The original function bodies retain source clearing, donor cropping/placement, leaders, typography, lossless export, pixel comparison and OCR. Outputs start with `accepted: false` and pending visual verdicts. Assembly's 0.70 OCR threshold and final qualification's 0.75 threshold are reported separately. Historical acceptance flags are never copied as approval of a new output. Full gallery counts and spend ceilings belong to the application's declared batch, not every request.

The compact report links the complete application record. Technical evidence remains available even for an interrupted or failed run. Native provider images are preserved inside the sanitized Muse receipt and materialized as a correctly typed image in the application Run folder, after checking that their decoded pixels match the recorded raster; the normalized raster is separate evidence for deterministic Assembly.

## Source fidelity and intentional adaptations

[Source manifest](source-manifest.json) records the exact original commits, file hashes, preserved symbol hashes and destination files. [Dependency recovery](../../docs/research/issue-91-port-dependencies.md) lists independent saved cases and application-owned data. [Source and Assembly replay](../../docs/research/issue-91-source-replay.json) records the original-versus-ported equality check.

Relocation changes: explicit application inputs/output paths, ESM export for the extracted product engine, local imports, and an installed tool inventory. Required safeguard integrations: the existing central reservation/recovery gates replace older post-call receipts; prompt and input hashes are checked before dispatch; provider errors are sanitized; native bytes/format, optional request identity and actual/unknown cost are retained; historical approvals remain unverified. Muse requests preserve their original prompt, ordered bytes, size and n=1, with the original 600-second timeout. No new creative or Seedance reference policy is introduced.

The installed runtime needs Python 3 with Pillow; product Assembly additionally needs NumPy, OpenCV and Tesseract plus the application's hash-locked fonts. Replay records the actual versions. `node scripts/package-tool.mjs` builds the checked local distribution; `bin/image-pipeline` uses that distribution. Builds are immutable and application locks require a deliberate upgrade after rebuilding. The distribution is a build candidate, not a published release.

To rerun the original-source comparison without spending, run `python3 scripts/replay_muse_port.py --help` and provide the four inspected source/application checkouts plus a report destination. Ordinary use never imports those checkouts. The baseline checks preserved source slices and gate failures; the explicit replay exercises original callers, saved prompts and donor pixels.

To reopen a recorded image without a credential, pass `image --execute --run RUN_ID` with its original application and Objective. The Run must already contain the authenticated provider receipt. A new run still refuses missing credentials before reservation.
