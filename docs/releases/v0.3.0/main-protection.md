# Main protection for v0.3.0

Issue #19 makes `main` release-only with the repository ruleset named
`main is release-only`.

The ruleset targets only `refs/heads/main`. It requires a pull request and the
`release-train` check, refuses deletion and force pushes, and permits only
merge commits. GitHub Actions has no bypass. The Release workflow must merge
the exact reviewed `build/v<version>` pull request through the ordinary
protected path.

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
