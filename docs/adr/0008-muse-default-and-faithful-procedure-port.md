# ADR 0008: Muse defaults and preserved procedures

Status: accepted by the owner's implementation direction in Issues #89–#93.

Muse through OpenRouter replaces Qwen as the image model. Seedance's existing nested CLI and strategy/waiver behavior remain unchanged. This supersedes Qwen-default statements in ADR 0006 and the model-specific wording of ADRs 0001/0002; deterministic Assembly remains the mechanism for exact preservation.

Port the saved general edit, DIS-photo composite/refinement and invented-product procedures separately. Their source inventory is `procedures/muse/source-manifest.json`. Preserve creative functions and request settings; move application layout data and all assets to application-owned inputs. Integrate the existing durable reservation and recovery controls in place of older unsafe paid-state writers.

Muse uses Run schema 3, with a size and optional source-file inventory, no Qwen seed. Schemas 1 and 2 retain historical replay semantics. Internal Python package names, `.qwen-pipeline` paths and normalized RGBA media identifiers remain compatibility names; they do not authorize Qwen generation. The live OpenRouter image client refuses other image models, and direct Alibaba submission is retired. Historical request builders remain for compatibility evidence.

Native image bytes, detected media type, optional provider ID and actual/unknown cost are preserved. A plain generated image needs visual review and cannot claim exact preservation. The unchanged strict region Assembly path still uses deterministic Verification and Review. The saved product Assembly exports its actual pixel/OCR evidence and fresh pending visual verdicts; its application-specific layouts, font hashes and donor records are explicit inputs. Historical approval scripts are not callable approval for new output.

The tool is distributed with the existing closed artifact inventory and called through `bin/image-pipeline`. Applications own locks, recipes, prompts, references, generated files and append-only Run Records. Shared skill routing is maintained through agentic-workflow Issue #275 and its existing build PR. No provider calls run in ordinary CI, and this migration does not cut a release or change Seedance's reference policy.

Obsolete application files are classified in `migration/muse-retirement.json`: necessary acceptance fixture bytes are relocated under `tests/fixtures/historical`, and other files remain recoverable at the exact recorded Git commit. No issue identity or Git history is rewritten.
