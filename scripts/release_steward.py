#!/usr/bin/env python3
"""Cut reviewed build lines as tags and produce a read-only cleanup plan.

Public commands:

    python3 scripts/release_steward.py --repo . --dry-run
    python3 scripts/release_steward.py cut 0.3.0 --repo . --dry-run
    python3 scripts/release_steward.py verify-tag v0.3.0 --repo .

The cut command pushes only ``refs/tags/v<version>``. GitHub's Release
workflow is the only automation that moves the protected ``main`` branch.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable


SHA_RE = re.compile(r"(?im)^\s*reviewed:\s*([0-9a-f]{40})\s*$")
VERDICT_RE = re.compile(r"(?im)^\s*verdict:\s*(\S+)\s*$")
KEEP_PREFIXES = ("capture/", "prototype/", "evidence/", "review/")


@dataclass(frozen=True)
class ReleaseEvidence:
    version: str
    branch: str
    target_sha: str
    remote_tip_sha: str
    release_page: str | None
    review_text: str | None
    tree_clean: bool
    changed_paths_from_review: frozenset[str]
    review_is_direct_parent: bool


@dataclass(frozen=True)
class ReleaseDecision:
    allowed: bool
    code: str | None
    message: str
    tag: str | None = None
    target_sha: str | None = None


@dataclass(frozen=True)
class WorktreeState:
    path: str
    branch: str | None
    merged_into_main: bool
    dirty: bool


@dataclass(frozen=True)
class CleanupState:
    open_build_branches: frozenset[str]
    merged_remote_branches: tuple[str, ...]
    worktrees: tuple[WorktreeState, ...]


def refused(code: str, message: str) -> ReleaseDecision:
    return ReleaseDecision(False, code, message)


def evaluate_release(evidence: ReleaseEvidence) -> ReleaseDecision:
    """Classify the evidence without performing a git or network operation."""

    version = evidence.version.removeprefix("v")
    tag = f"v{version}"
    if evidence.branch != f"build/{tag}":
        return refused(
            "WRONG_BUILD_BRANCH",
            f"{tag} may be cut only from build/{tag}, not {evidence.branch}",
        )
    if not evidence.release_page:
        return refused("MISSING_RELEASE_PAGE", f"docs/releases/{tag}/RELEASE.md is missing")
    if not evidence.review_text:
        return refused("MISSING_REVIEW", f"docs/releases/{tag}/REVIEW.md is missing")
    verdict_match = VERDICT_RE.search(evidence.review_text)
    verdict = verdict_match.group(1).lower() if verdict_match else ""
    if verdict == "hold":
        return refused("HOLD_VERDICT", f"the {tag} review says hold")
    if verdict != "ship":
        return refused("INVALID_VERDICT", f"the {tag} review must say verdict: ship or verdict: hold")
    reviewed_match = SHA_RE.search(evidence.review_text)
    if not reviewed_match:
        return refused("MISSING_REVIEW", f"the {tag} review does not name one full reviewed SHA")
    if not evidence.tree_clean:
        return refused("DIRTY_TREE", "the release checkout contains uncommitted work")
    if evidence.target_sha != evidence.remote_tip_sha:
        return refused("UNPUSHED_TIP", "the local candidate is not the pushed build-line tip")

    reviewed = reviewed_match.group(1)
    if reviewed != evidence.target_sha:
        allowed_paths = {
            f"docs/releases/{tag}/REVIEW.md",
            f"docs/releases/{tag}/RELEASE.md",
        }
        paths = set(evidence.changed_paths_from_review)
        evidence_only = (
            evidence.review_is_direct_parent
            and f"docs/releases/{tag}/REVIEW.md" in paths
            and bool(paths)
            and paths <= allowed_paths
        )
        if not evidence_only:
            return refused(
                "STALE_REVIEW",
                f"the review names {reviewed[:12]}, not candidate {evidence.target_sha[:12]}",
            )
    return ReleaseDecision(True, None, f"{tag} may name {evidence.target_sha}", tag, evidence.target_sha)


def _branch_keep_reason(branch: str, open_build_branches: frozenset[str]) -> str | None:
    if branch == "main":
        return "main checkout"
    if branch in open_build_branches:
        return "open build line"
    if branch.startswith(KEEP_PREFIXES):
        return "evidence branch"
    return None


def plan_cleanup(state: CleanupState) -> tuple[str, ...]:
    """Return stable prose actions; this function has no write adapter."""

    actions: list[str] = []
    for branch in sorted(set(state.merged_remote_branches)):
        if branch in {"origin", "HEAD", "origin/HEAD"}:
            continue
        reason = _branch_keep_reason(branch, state.open_build_branches)
        if reason:
            actions.append(f"keep remote {branch}: {reason}")
        else:
            actions.append(f"would delete remote {branch}: merged into main")
    for worktree in sorted(state.worktrees, key=lambda item: item.path):
        reason = _branch_keep_reason(worktree.branch or "", state.open_build_branches)
        if reason:
            actions.append(f"keep worktree {worktree.path}: {reason}")
        elif worktree.dirty:
            actions.append(f"keep worktree {worktree.path}: uncommitted changes")
        elif worktree.merged_into_main:
            actions.append(f"would remove worktree {worktree.path}: merged into main")
        else:
            actions.append(f"keep worktree {worktree.path}: active unmerged work")
    return tuple(actions)


class Git:
    def __init__(self, repo: Path):
        self.repo = repo

    def run(self, *args: str, check: bool = True) -> str:
        result = subprocess.run(
            ["/usr/bin/git", *args],
            cwd=self.repo,
            text=True,
            capture_output=True,
            check=False,
        )
        if check and result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout).strip())
        return result.stdout.strip()

    def fetch(self) -> None:
        self.run("fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*")

    def branch(self) -> str:
        return self.run("branch", "--show-current")

    def sha(self, ref: str = "HEAD") -> str:
        return self.run("rev-parse", f"{ref}^{{commit}}")

    def clean(self, path: Path | None = None) -> bool:
        return not self.run("-C", str(path or self.repo), "status", "--porcelain")

    def parents(self, sha: str) -> tuple[str, ...]:
        row = self.run("rev-list", "--parents", "-n", "1", sha).split()
        return tuple(row[1:])

    def changed_paths(self, old: str, new: str) -> frozenset[str]:
        return frozenset(self.run("diff", "--name-only", old, new).splitlines())

    def local_tag_target(self, tag: str) -> str | None:
        result = self.run("rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}", check=False)
        return result or None

    def remote_tag_target(self, tag: str) -> str | None:
        row = self.run("ls-remote", "--tags", "origin", f"refs/tags/{tag}^{{}}", check=False)
        if row:
            return row.split()[0]
        row = self.run("ls-remote", "--tags", "origin", f"refs/tags/{tag}", check=False)
        return row.split()[0] if row else None

    def create_tag(self, tag: str, target: str, message: str) -> None:
        self.run("tag", "-a", tag, target, "-m", message)

    def push_tag(self, tag: str) -> None:
        self.run("push", "origin", f"refs/tags/{tag}:refs/tags/{tag}")


def _release_files(repo: Path, tag: str) -> tuple[str | None, str | None]:
    folder = repo / "docs" / "releases" / tag
    page = folder / "RELEASE.md"
    review = folder / "REVIEW.md"
    return (
        page.read_text() if page.exists() else None,
        review.read_text() if review.exists() else None,
    )


def evidence_from_repo(repo: Path, git: Git, version: str, *, tag_checkout: bool = False) -> ReleaseEvidence:
    version = version.removeprefix("v")
    tag = f"v{version}"
    target = git.sha(f"refs/tags/{tag}" if tag_checkout else "HEAD")
    branch = f"build/{tag}" if tag_checkout else git.branch()
    remote_tip = target if tag_checkout else git.sha(f"origin/{branch}")
    page, review = _release_files(repo, tag)
    reviewed_match = SHA_RE.search(review or "")
    reviewed = reviewed_match.group(1) if reviewed_match else None
    direct_parent = bool(reviewed and reviewed in git.parents(target))
    changed = git.changed_paths(reviewed, target) if reviewed and direct_parent else frozenset()
    return ReleaseEvidence(
        version=version,
        branch=branch,
        target_sha=target,
        remote_tip_sha=remote_tip,
        release_page=page,
        review_text=review,
        tree_clean=git.clean(),
        changed_paths_from_review=changed,
        review_is_direct_parent=direct_parent,
    )


def _lead(page: str) -> str:
    paragraphs: list[str] = []
    for block in re.split(r"\n\s*\n", page.strip()):
        if block.startswith("#"):
            continue
        paragraphs.append(" ".join(block.splitlines()))
    return paragraphs[0] if paragraphs else "Reviewed release"


def cut_release(
    evidence: ReleaseEvidence,
    git: Git,
    gates: Iterable[Callable[[], int]],
    *,
    dry_run: bool,
) -> ReleaseDecision:
    decision = evaluate_release(evidence)
    if not decision.allowed:
        return decision
    assert decision.tag and decision.target_sha and evidence.release_page
    for existing in (git.local_tag_target(decision.tag), git.remote_tag_target(decision.tag)):
        if existing and existing != decision.target_sha:
            return refused("TAG_CONFLICT", f"{decision.tag} already names {existing}")
    for gate in gates:
        if not dry_run and gate() != 0:
            return refused("GATE_FAILED", "a deterministic release gate failed; no tag was created")
    if not dry_run and not git.local_tag_target(decision.tag):
        git.create_tag(decision.tag, decision.target_sha, _lead(evidence.release_page))
    if not dry_run and not git.remote_tag_target(decision.tag):
        git.push_tag(decision.tag)
    return decision


def observe_cleanup(git: Git) -> CleanupState:
    remote_rows = git.run("for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin/build/").splitlines()
    open_lines = frozenset(row for row in remote_rows if row)
    merged = tuple(
        row.removeprefix("origin/")
        for row in git.run("branch", "-r", "--merged", "origin/main", "--format=%(refname:short)").splitlines()
        if row and row != "origin/main"
    )
    worktree_rows = git.run("worktree", "list", "--porcelain").split("\n\n")
    worktrees: list[WorktreeState] = []
    for record in worktree_rows:
        fields = dict(line.split(" ", 1) for line in record.splitlines() if " " in line)
        path = fields.get("worktree")
        if not path:
            continue
        branch_ref = fields.get("branch")
        branch = branch_ref.removeprefix("refs/heads/") if branch_ref else None
        head = fields.get("HEAD", "")
        merged_into_main = not bool(git.run("rev-list", "-n", "1", f"{head}", "--not", "origin/main", check=False)) if head else False
        worktrees.append(WorktreeState(path, branch, merged_into_main, not git.clean(Path(path))))
    return CleanupState(open_lines, merged, tuple(worktrees))


def run_gate(repo: Path) -> int:
    return subprocess.run([str(repo / "scripts" / "verify.sh")], cwd=repo, check=False).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("all", "cut", "verify-tag"), default="all")
    parser.add_argument("version", nargs="?")
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    git = Git(repo)
    try:
        git.fetch()
        if args.command == "all":
            if not args.dry_run:
                print("steward refused: cleanup is available only as --dry-run", file=sys.stderr)
                return 2
            print("release-steward (dry-run: nothing is written)")
            for action in plan_cleanup(observe_cleanup(git)):
                print(action)
            return 0
        if not args.version:
            parser.error(f"{args.command} requires a version")
        if args.command == "verify-tag":
            decision = evaluate_release(evidence_from_repo(repo, git, args.version, tag_checkout=True))
        else:
            current = evidence_from_repo(repo, git, args.version)
            decision = cut_release(current, git, [lambda: run_gate(repo)], dry_run=args.dry_run)
        print(decision.message)
        if args.command == "cut" and args.dry_run and decision.allowed:
            print(f"would run scripts/verify.sh")
            print(f"would push only refs/tags/{decision.tag}")
        return 0 if decision.allowed else 1
    except Exception as exc:
        print(f"release steward failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
