#!/usr/bin/env python3
"""Cut reviewed build lines as tags and produce a read-only cleanup plan.

Public commands:

    python3 scripts/release_steward.py --repo . --dry-run
    python3 scripts/release_steward.py cut 0.3.0 --review-file /outside/tree/review.md --repo . --dry-run
    python3 scripts/release_steward.py verify-tag v0.3.0 --repo .

The cut command pushes only ``refs/tags/v<version>``. GitHub's Release
workflow is the only automation that moves the protected ``main`` branch.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterable


VERSION_RE = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")
KEEP_PREFIXES = ("capture/", "prototype/", "evidence/", "review/")
RECEIPT_SCHEMA = "qwen-image-pipeline/release-review/v1"
RECEIPT_PREFIX = "release-review-receipt: "
REVIEW_SOURCE_RE = re.compile(
    r"https://github\.com/Reid-Surmeier/qwen-image-pipeline/issues/[1-9][0-9]*#issuecomment-([1-9][0-9]*)"
)
REVIEW_MARKERS = ("review-axis", "reviewer-id", "reviewed", "verdict")


@dataclass(frozen=True)
class ReleaseEvidence:
    version: str
    branch: str
    target_sha: str
    remote_tip_sha: str
    release_page: str | None
    review_text: str | None
    review_authenticated: bool
    tree_clean: bool
    tag_is_annotated: bool | None = None


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
    active_evidence_branches: frozenset[str] = frozenset()


def refused(code: str, message: str) -> ReleaseDecision:
    return ReleaseDecision(False, code, message)


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate receipt field: {key}")
        result[key] = value
    return result


def parse_review_receipt(text: str) -> dict[str, object]:
    """Parse one strict two-axis receipt, rejecting duplicate or extra claims."""

    candidates = [
        line.removeprefix(RECEIPT_PREFIX)
        for line in text.splitlines()
        if line.startswith(RECEIPT_PREFIX)
    ]
    payload = candidates[0] if len(candidates) == 1 else text.strip()
    if len(candidates) > 1:
        raise ValueError("the tag contains more than one review receipt")
    value = json.loads(payload, object_pairs_hook=_unique_object)
    if not isinstance(value, dict):
        raise ValueError("the review receipt must be an object")
    if set(value) != {"schema", "reviewed", "verdict", "reviews"}:
        raise ValueError("the review receipt has missing or unknown fields")
    if value["schema"] != RECEIPT_SCHEMA:
        raise ValueError("the review receipt schema is unsupported")
    reviewed = value["reviewed"]
    if not isinstance(reviewed, str) or not re.fullmatch(r"[0-9a-f]{40}", reviewed):
        raise ValueError("reviewed must be one full lowercase commit SHA")
    if value["verdict"] not in {"ship", "hold"}:
        raise ValueError("verdict must be ship or hold")
    reviews = value["reviews"]
    if not isinstance(reviews, list) or len(reviews) != 2:
        raise ValueError("the receipt must contain exactly two review axes")
    axes: set[str] = set()
    reviewers: set[str] = set()
    sources: set[str] = set()
    for review in reviews:
        if not isinstance(review, dict) or set(review) != {
            "axis", "reviewer", "source", "source_sha256"
        }:
            raise ValueError("each review axis must use the frozen evidence fields")
        axis = review["axis"]
        reviewer = review["reviewer"]
        source = review["source"]
        digest = review["source_sha256"]
        if axis not in {"Standards", "Specification"}:
            raise ValueError("review axis must be Standards or Specification")
        if not isinstance(reviewer, str) or not reviewer.strip():
            raise ValueError("each review axis must name its reviewer")
        if not isinstance(source, str) or not REVIEW_SOURCE_RE.fullmatch(source):
            raise ValueError("review source must be a repository Issue comment URL")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("review source hash must be one lowercase SHA-256")
        axes.add(axis)
        reviewers.add(reviewer)
        sources.add(source)
    if axes != {"Standards", "Specification"} or len(reviewers) != 2 or len(sources) != 2:
        raise ValueError("Standards and Specification require distinct reviewers and sources")
    return value


def canonical_review_receipt(text: str) -> str:
    return json.dumps(parse_review_receipt(text), sort_keys=True, separators=(",", ":"))


def _comment_markers(body: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for line in body.splitlines():
        if ":" not in line:
            continue
        key, value = (part.strip() for part in line.split(":", 1))
        if key not in REVIEW_MARKERS:
            continue
        if key in found:
            raise ValueError(f"duplicate review comment marker: {key}")
        found[key] = value
    if set(found) != set(REVIEW_MARKERS):
        raise ValueError("review comment is missing a required marker")
    return found


def authenticate_review_receipt(
    text: str,
    fetch_comment: Callable[[str], dict[str, object]],
) -> bool:
    """Bind both receipt entries to owner-authenticated GitHub comments."""

    try:
        receipt = parse_review_receipt(text)
        reviewed = str(receipt["reviewed"])
        verdict = str(receipt["verdict"])
        for review in receipt["reviews"]:  # type: ignore[union-attr]
            assert isinstance(review, dict)
            record = fetch_comment(str(review["source"]))
            user = record.get("user")
            body = record.get("body")
            if (
                not isinstance(user, dict)
                or user.get("login") != "Reid-Surmeier"
                or record.get("author_association") != "OWNER"
                or not isinstance(body, str)
            ):
                return False
            if hashlib.sha256(body.encode("utf-8")).hexdigest() != review["source_sha256"]:
                return False
            markers = _comment_markers(body)
            if markers != {
                "review-axis": review["axis"],
                "reviewer-id": review["reviewer"],
                "reviewed": reviewed,
                "verdict": verdict,
            }:
                return False
        return True
    except (AssertionError, KeyError, RuntimeError, TypeError, ValueError, json.JSONDecodeError):
        return False


def fetch_github_comment(source: str) -> dict[str, object]:
    match = REVIEW_SOURCE_RE.fullmatch(source)
    if not match:
        raise ValueError("invalid review source")
    result = subprocess.run(
        [
            "gh",
            "api",
            f"repos/Reid-Surmeier/qwen-image-pipeline/issues/comments/{match.group(1)}",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("GitHub review evidence could not be read")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise RuntimeError("GitHub returned invalid review evidence")
    return value


def evaluate_release(evidence: ReleaseEvidence) -> ReleaseDecision:
    """Classify the evidence without performing a git or network operation."""

    version = evidence.version.removeprefix("v")
    if not VERSION_RE.fullmatch(version):
        return refused("INVALID_VERSION", f"{evidence.version} is not an exact semantic version")
    tag = f"v{version}"
    if evidence.tag_is_annotated is False:
        return refused("UNANNOTATED_TAG", f"{tag} is lightweight; releases require annotated tags")
    if evidence.branch != f"build/{tag}":
        return refused(
            "WRONG_BUILD_BRANCH",
            f"{tag} may be cut only from build/{tag}, not {evidence.branch}",
        )
    if not evidence.release_page:
        return refused("MISSING_RELEASE_PAGE", f"docs/releases/{tag}/RELEASE.md is missing")
    if not evidence.review_text:
        return refused("MISSING_REVIEW", f"the exact-SHA Standards and Spec receipt for {tag} is missing")
    try:
        receipt = parse_review_receipt(evidence.review_text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return refused("INVALID_REVIEW", f"the {tag} review receipt is malformed or contradictory")
    verdict = str(receipt["verdict"])
    if verdict == "hold":
        return refused("HOLD_VERDICT", f"the {tag} review says hold")
    if not evidence.review_authenticated:
        return refused(
            "UNAUTHENTICATED_REVIEW",
            f"the {tag} Standards and Specification sources are not authenticated",
        )
    if not evidence.tree_clean:
        return refused("DIRTY_TREE", "the release checkout contains uncommitted work")
    if evidence.target_sha != evidence.remote_tip_sha:
        return refused("UNPUSHED_TIP", "the local candidate is not the pushed build-line tip")

    reviewed = str(receipt["reviewed"])
    if reviewed != evidence.target_sha:
        return refused(
            "STALE_REVIEW",
            f"the review names {reviewed[:12]}, not candidate {evidence.target_sha[:12]}",
        )
    return ReleaseDecision(True, None, f"{tag} may name {evidence.target_sha}", tag, evidence.target_sha)


def _branch_keep_reason(
    branch: str,
    open_build_branches: frozenset[str],
    active_evidence_branches: frozenset[str],
) -> str | None:
    if branch == "main":
        return "main checkout"
    if branch in open_build_branches:
        return "open build line"
    if branch in active_evidence_branches:
        return "active evidence"
    if branch.startswith(KEEP_PREFIXES):
        return "evidence branch"
    return None


def plan_cleanup(state: CleanupState) -> tuple[str, ...]:
    """Return stable prose actions; this function has no write adapter."""

    actions: list[str] = []
    for branch in sorted(set(state.merged_remote_branches)):
        if branch in {"origin", "HEAD", "origin/HEAD"}:
            continue
        reason = _branch_keep_reason(branch, state.open_build_branches, state.active_evidence_branches)
        if reason:
            actions.append(f"keep remote {branch}: {reason}")
        else:
            actions.append(f"would delete remote {branch}: merged into main")
    for worktree in sorted(state.worktrees, key=lambda item: item.path):
        reason = _branch_keep_reason(
            worktree.branch or "",
            state.open_build_branches,
            state.active_evidence_branches,
        )
        if worktree.dirty:
            actions.append(f"keep worktree {worktree.path}: uncommitted changes")
        elif reason:
            actions.append(f"keep worktree {worktree.path}: {reason}")
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

    def branch(self) -> str:
        return self.run("branch", "--show-current")

    def sha(self, ref: str = "HEAD") -> str:
        return self.run("rev-parse", f"{ref}^{{commit}}")

    def clean(self, path: Path | None = None) -> bool:
        checkout = path or self.repo
        tracked = subprocess.run(
            ["/usr/bin/git", "-C", str(checkout), "diff", "--quiet", "HEAD", "--"],
            cwd=self.repo,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode == 0
        untracked = self.run("-C", str(checkout), "ls-files", "--others", "--exclude-standard")
        return tracked and not untracked

    def remote_branch_target(self, branch: str) -> str:
        row = self.run("ls-remote", "--heads", "origin", f"refs/heads/{branch}", check=False)
        if not row:
            raise RuntimeError(f"origin/{branch} does not exist")
        return row.split()[0]

    def local_tag_target(self, tag: str) -> str | None:
        result = self.run("rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}", check=False)
        return result or None

    def local_tag_kind(self, tag: str) -> str | None:
        result = self.run("cat-file", "-t", f"refs/tags/{tag}", check=False)
        return result or None

    def tag_message(self, tag: str) -> str | None:
        if self.local_tag_kind(tag) != "tag":
            return None
        result = self.run("for-each-ref", "--format=%(contents)", f"refs/tags/{tag}", check=False)
        return result or None

    def local_tag_object(self, tag: str) -> str | None:
        result = self.run("rev-parse", "--verify", f"refs/tags/{tag}", check=False)
        return result or None

    def remote_tag_object(self, tag: str) -> str | None:
        row = self.run("ls-remote", "--tags", "origin", f"refs/tags/{tag}", check=False)
        return row.split()[0] if row else None

    def remote_tag_target(self, tag: str) -> str | None:
        row = self.run("ls-remote", "--tags", "origin", f"refs/tags/{tag}^{{}}", check=False)
        if row:
            return row.split()[0]
        row = self.run("ls-remote", "--tags", "origin", f"refs/tags/{tag}", check=False)
        return row.split()[0] if row else None

    def remote_tag_is_annotated(self, tag: str) -> bool | None:
        rows = self.run(
            "ls-remote",
            "--tags",
            "origin",
            f"refs/tags/{tag}",
            f"refs/tags/{tag}^{{}}",
            check=False,
        ).splitlines()
        if not rows:
            return None
        return any(row.split()[-1].endswith("^{}") for row in rows)

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


def evidence_from_repo(
    repo: Path,
    git: Git,
    version: str,
    *,
    tag_checkout: bool = False,
    review_text: str | None = None,
    review_authenticated: bool = False,
) -> ReleaseEvidence:
    version = version.removeprefix("v")
    tag = f"v{version}"
    target = git.sha(f"refs/tags/{tag}" if tag_checkout else "HEAD")
    branch = f"build/{tag}" if tag_checkout else git.branch()
    remote_tip = target if tag_checkout else git.remote_branch_target(branch)
    page, file_review = _release_files(repo, tag)
    review = git.tag_message(tag) if tag_checkout else review_text or file_review
    return ReleaseEvidence(
        version=version,
        branch=branch,
        target_sha=target,
        remote_tip_sha=remote_tip,
        release_page=page,
        review_text=review,
        review_authenticated=review_authenticated,
        tree_clean=git.clean(),
        tag_is_annotated=(git.local_tag_kind(tag) == "tag") if tag_checkout else None,
    )


def _lead(page: str) -> str:
    paragraphs: list[str] = []
    for block in re.split(r"\n\s*\n", page.strip()):
        if block.startswith("#"):
            continue
        paragraphs.append(" ".join(block.splitlines()))
    return paragraphs[0] if paragraphs else "Reviewed release"


def _tag_message(page: str, review_text: str) -> str:
    return f"{_lead(page)}\n\n{RECEIPT_PREFIX}{canonical_review_receipt(review_text)}"


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
    local_target = git.local_tag_target(decision.tag)
    remote_target = git.remote_tag_target(decision.tag)
    for existing in (local_target, remote_target):
        if existing and existing != decision.target_sha:
            return refused("TAG_CONFLICT", f"{decision.tag} already names {existing}")
    if local_target and git.local_tag_kind(decision.tag) != "tag":
        return refused("UNANNOTATED_TAG", f"local {decision.tag} is lightweight")
    if remote_target and git.remote_tag_is_annotated(decision.tag) is not True:
        return refused("UNANNOTATED_TAG", f"remote {decision.tag} is lightweight")
    expected_message = _tag_message(evidence.release_page, evidence.review_text or "")
    if local_target and git.tag_message(decision.tag) != expected_message:
        return refused("TAG_RECEIPT_MISMATCH", f"local {decision.tag} carries different review evidence")
    if remote_target:
        local_object = git.local_tag_object(decision.tag) if local_target else None
        if not local_object or git.remote_tag_object(decision.tag) != local_object:
            return refused("TAG_RECEIPT_MISMATCH", f"remote {decision.tag} is not the reviewed local tag object")
    for gate in gates:
        if not dry_run and gate() != 0:
            return refused("GATE_FAILED", "a deterministic release gate failed; no tag was created")
    if not dry_run and not local_target:
        assert evidence.review_text
        git.create_tag(
            decision.tag,
            decision.target_sha,
            expected_message,
        )
    if not dry_run and not remote_target:
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
    active = frozenset(
        item.branch
        for item in worktrees
        if item.branch and item.branch != "main" and item.branch not in open_lines
    )
    return CleanupState(open_lines, merged, tuple(worktrees), active)


def run_gate(repo: Path) -> int:
    return subprocess.run([str(repo / "scripts" / "verify.sh")], cwd=repo, check=False).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("all", "cut", "verify-tag"), default="all")
    parser.add_argument("version", nargs="?")
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--review-file", type=Path)
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    git = Git(repo)
    try:
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
        version = args.version.removeprefix("v")
        if not VERSION_RE.fullmatch(version):
            print(f"{args.version} is not an exact semantic version")
            return 1
        if args.command == "verify-tag":
            candidate = evidence_from_repo(repo, git, version, tag_checkout=True)
            authenticated = bool(
                candidate.review_text
                and authenticate_review_receipt(candidate.review_text, fetch_github_comment)
            )
            candidate = replace(candidate, review_authenticated=authenticated)
            decision = evaluate_release(candidate)
        else:
            if not args.review_file or not args.review_file.is_file():
                print("cut requires --review-file with the exact-SHA Standards and Spec ship receipt")
                return 1
            review_text = args.review_file.read_text(encoding="utf-8")
            authenticated = authenticate_review_receipt(review_text, fetch_github_comment)
            current = evidence_from_repo(
                repo,
                git,
                version,
                review_text=review_text,
                review_authenticated=authenticated,
            )
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
