# Main protection for v0.3.0

Issue #19 makes `main` release-only with the repository ruleset named
`main is release-only`.

The ruleset targets only `refs/heads/main`. It requires a pull request, the
`release-train` check, and a successful deployment to the `release-train`
environment; it refuses deletion and force pushes and permits only merge
commits. GitHub Actions has no bypass. The status is pinned to the GitHub
Actions integration (app ID `15368`). The environment accepts only `v*` tag
refs, and tag ruleset `21882710` restricts creation, update, deletion, and
non-fast-forward movement of those refs to the owner bypass. A candidate
workflow can imitate the status name but cannot satisfy the required
deployment without the owner-cut tag. The Release workflow waits for that
status and merges only the head commit it already matched through the
protected path; GitHub independently enforces the deployment requirement.

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

The only bypass actor on both rulesets is the repository owner, GitHub user `Reid-Surmeier`
(numeric actor ID `304586061`). This is the explicit owner brake for recovery;
using it is a human production decision, never an agent default.

`main-ruleset-request.json` and `tag-ruleset-request.json` are the exact
requests. Their `*-live.json` siblings record GitHub rulesets `21881100` and
`21882710`. The environment request, live response, and exact `v*` tag policy
are captured beside them. GitHub's workflow-file rule is organization-level;
this personal repository instead composes its repository ruleset, tag ruleset,
and environment ref policy so a copied status context is insufficient.

Refresh the live proof without modifying it:

```bash
gh api repos/Reid-Surmeier/qwen-image-pipeline/rulesets/21881100
gh api repos/Reid-Surmeier/qwen-image-pipeline/rulesets/21882710
gh api repos/Reid-Surmeier/qwen-image-pipeline/environments/release-train
```
