# Muse migration implementation review

Governing spec: #89; implementation tickets #90–93. Reviewed code: `7713960a7f1a88424e655d0f0ac013872259158f` against `018bddde501bff068d7984999cef852996b96fb4`. This note records the scoped implementation review; it is not a release receipt and does not authorize a tag, merge or visual approval.

## Standards

**Pass.** Independent reviewer `muse_standards_review` rechecked the final source after corrections. Interrupted Muse receipts recover without a provider client; empty Assembly input refuses; native pixels are checked against their recorded raster; credential-free resume requires an authenticated existing receipt. Missing and empty Run IDs refuse before reservation. No residual implementation blockers were reported.

## Specification

**Pass.** Independent reviewer `muse_spec_review` checked the same final source. The central product donor export reaches the preserved Assembly, reference transmission follows declared indices, verified results identify the assembled candidate, and Assembly uses the compact report. No residual spec blockers were reported. Source and routing evidence below distinguishes checks that ran from missing historical/live evidence.

## Executed evidence

- `scripts/verify.sh`: passed; 254 Python tests (2 skips), 19 Node tests, 215 control-plane tests (214 passed, 1 skipped). The provider-capable subprocess probe remains excluded by the offline baseline. Source inventory, migration/governance, module map/seams, typecheck, vendored pins, compilation and diff checks passed.
- Focused Muse/transport suite: 5 passed, including local native-image decoding, mismatched-image refusal, interrupted output persistence, non-retryable ambiguity and payload-index order. Focused Python Muse/source/cleanup suite: 7 passed, including invalid cost/count, receipt recovery, source-slice equality and fixture hashes.
- Seedance: `PYTHONPATH=src python3 -m pytest tests -q` from `seedance/`: 78 passed. Running those tests from the outer repository initially caused three reference-fixture path failures; the package's proper working directory passes without changing its code or requirements.
- `scripts/replay_muse_port.py`: [record](../../research/issue-91-source-replay.json). Original edit/composite/refinement requests equal the port; six independent saved packets and ten prompts match. Original and ported Assembly produce identical encoded output and pixels, zero changed pixels outside declared masks, OCR 0.975, and matching copy/fit/media checks. The refinement oracle is the original caller; no saved refinement result is claimed.
- `scripts/replay_muse_product_run.py`: [record](../../research/issue-91-central-smoke.json). A recorded donor is injected into the checked installed Conductor path, then exported, assembled and reopened without credentials. No-key new execution and empty recovery identity refuse before any Run is created. The resulting Assembly hash matches the original. Reported $0.01 donor cost comes from the injected historical receipt; this test spent $0.
- [Installed routing](../../research/issue-92-installed-routing.json): a fresh agent read installed instructions/skills and actually invoked creation, edit, product and animation paths in isolated applications. Creation/edit/product plan with Muse. Animation reaches Seedance and refuses missing local capabilities evidence; no network capability fetch or waiver is supplied. The final-artifact section records commit `7713960a7f1a88424e655d0f0ac013872259158f` and artifact `2b9539945fad934f9126324da4d65c05008c98a5b05d92874b91fbe9f8544534`.
- Secret scan of the implementation commits: no leaks.

A final CI-only review found no material issues in the prerequisite change and its matching governance check. The CI workflow installs Pillow, NumPy and OpenCV for `/usr/bin/python3.12`, which the canonical baseline deliberately pins; installing only into setup-python's interpreter does not supply these new deterministic prerequisites.

## Scope and ownership

The two JPGs in this folder are comparison evidence. Original references, fonts, donors, full-size outputs, recipes and Run Records remain in their applications. [The retirement inventory](../../../migration/muse-retirement.json) preserves hashes and recovery commits for 897 obsolete active paths, and points to retained historical fixtures. The old GitHub issues and original repository identity remain intact.

Shared source is `agentic-workflow` commit `69b9e020d9fc9c71513d551c2c204566a584042e`, on [build PR #190](https://github.com/Reid-Surmeier/agentic-workflow/pull/190). It passed 633 tests before integration and 649 on the integrated candidate (four skips), Ruff, strict source audit, secret scan and diff check. Issue #275's five-path Codex sync ran and then reported zero remaining scoped operations. Broad host audit findings (unrelated drift, existing filename backups and expired shares) remain outside this task. Source links point to the maintained build worktree while its normal release is pending; this implementation did not change propagation services.

There were zero paid generations. No live Muse/Seedance qualification, new motion-reference policy, blanket waiver, subjective approval, build merge or release tag was performed.
