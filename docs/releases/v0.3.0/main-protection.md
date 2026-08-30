# Main protection for v0.3.0

Issue #19 makes `main` release-only with the repository ruleset named
`main is release-only`.

The ruleset targets only `refs/heads/main`. It requires a pull request and the
`release-train` check, refuses deletion and force pushes, and permits only
merge commits. GitHub Actions has no bypass. The required status is pinned to
the GitHub Actions integration (app ID `15368`) and exists only
after an annotated version tag is bound to exact current ship evidence and the
one matching build PR. The Release workflow waits for that status and merges
only the head commit it already matched through the protected path.

The exact-SHA Standards and Specification receipt is supplied to `cut` from
outside the candidate tree and embedded canonically in the annotated tag. It
names two distinct reviewers and the SHA-256 of their GitHub-authenticated
owner Issue comments. Release train reads it back from that immutable tag and
re-authenticates both sources, so a free-form local file cannot award itself a
ship verdict. An existing tag is accepted only when its complete tag object
carries the exact supplied receipt.

Release polls the exact tag commit for the GitHub Actions `release-train`
check. It refuses failure or a five-minute absence instead of relying on a PR
check command that can exit before the concurrently started check appears.

The only bypass actor is the repository owner, GitHub user `Reid-Surmeier`
(numeric actor ID `304586061`). This is the explicit owner brake for recovery;
using it is a human production decision, never an agent default.

`main-ruleset-request.json` is the exact create request.
`main-ruleset-live.json` records GitHub ruleset `21881100` and the complete
configuration returned immediately after creation on 2026-08-30.

Refresh the live proof without modifying it:

```bash
gh api repos/Reid-Surmeier/qwen-image-pipeline/rulesets/21881100
```
