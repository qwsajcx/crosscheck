#!/usr/bin/env python3
"""doc-review-loop — two-LLM document modify/review loop orchestrator.

Alternates a "modifier" model and a "reviewer" model over one document:
the modifier edits, the reviewer writes a review file ending with
`结论: [PASS]` or `结论: [FAIL]`. The same modifier may edit at most
--streak-limit consecutive rounds, then roles swap. Loop ends on [PASS],
--max-rounds, or repeated no-change rounds. Git commits are made by this
orchestrator only (never `git add -A`, only the two managed files).
"""
import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_CMD_A = "kimi -p {prompt} --auto"
DEFAULT_CMD_B = "codex exec --sandbox workspace-write -C {repo} {prompt}"
SKILL_DIR = Path(__file__).resolve().parent.parent


def ts():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class Runner:
    def __init__(self, args):
        self.args = args
        self.log_fh = open(args.runs_dir / "run.log", "a", encoding="utf-8")

    def log(self, msg):
        line = f"[{ts()}] {msg}"
        print(line, flush=True)
        self.log_fh.write(line + "\n")
        self.log_fh.flush()

    def status(self, **kw):
        kw["updated"] = ts()
        kw["pid"] = os.getpid()
        (self.args.runs_dir / "status.json").write_text(
            json.dumps(kw, ensure_ascii=False, indent=2), encoding="utf-8")

    def git(self, *git_args, check=True):
        r = subprocess.run(["git", "-C", str(self.args.repo), *git_args],
                           capture_output=True, text=True)
        if check and r.returncode != 0:
            raise RuntimeError(f"git {' '.join(git_args)} failed: {r.stderr.strip()}")
        return r

    def run_agent(self, cmd_template, prompt, timeout):
        argv = [tok.replace("{prompt}", prompt).replace("{repo}", str(self.args.repo))
                for tok in shlex.split(cmd_template)]
        self.log(f"exec: {shlex.join([a if a != prompt else '<prompt>' for a in argv])}")
        with open(self.args.runs_dir / "agents.log", "a", encoding="utf-8") as out:
            out.write(f"\n===== [{ts()}] agent call =====\n")
            out.flush()
            p = subprocess.Popen(argv, stdout=out, stderr=subprocess.STDOUT,
                                 cwd=str(self.args.repo), start_new_session=True)
            try:
                return p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
                self.log(f"TIMEOUT after {timeout}s, process group killed")
                return None


def render(template_path, mapping):
    text = template_path.read_text(encoding="utf-8")
    for k, v in mapping.items():
        text = text.replace("{" + k + "}", str(v))
    return text


def last_nonempty_line(path):
    try:
        lines = [l.strip() for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
        return lines[-1] if lines else ""
    except FileNotFoundError:
        return ""


def main():
    ap = argparse.ArgumentParser(description="Two-LLM document review loop")
    ap.add_argument("doc", help="target document path (inside a git repo)")
    ap.add_argument("--repo", help="git repo root (default: auto-detect from doc)")
    ap.add_argument("--review-file", help="review file path (default: <doc_stem>.review.md next to doc)")
    ap.add_argument("--max-rounds", type=int, default=10)
    ap.add_argument("--streak-limit", type=int, default=2,
                    help="max consecutive modification rounds before role swap")
    ap.add_argument("--cmd-a", default=DEFAULT_CMD_A, help="model A command template, {prompt}/{repo} placeholders")
    ap.add_argument("--cmd-b", default=DEFAULT_CMD_B, help="model B command template")
    ap.add_argument("--name-a", default="Kimi", help="model A label for logs/commits")
    ap.add_argument("--name-b", default="Codex", help="model B label for logs/commits")
    ap.add_argument("--timeout", type=int, default=1800, help="per agent call, seconds")
    ap.add_argument("--branch", help="create/switch to this branch before starting")
    ap.add_argument("--push", metavar="REMOTES",
                    help="comma-separated remotes to push to when the loop ends (all are pushed)")
    ap.add_argument("--runs-dir", help="log/status dir (default: <repo>/.review-loop/<timestamp>)")
    ap.add_argument("--prompts-dir", default=str(SKILL_DIR / "prompts"))
    args = ap.parse_args()

    doc = Path(args.doc).resolve()
    if args.repo:
        repo = Path(args.repo).resolve()
    else:
        r = subprocess.run(["git", "-C", str(doc.parent), "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"error: {doc} is not inside a git repository")
        repo = Path(r.stdout.strip())
    try:
        doc.relative_to(repo)
    except ValueError:
        sys.exit(f"error: doc {doc} is outside repo {repo}")
    args.repo = repo

    review_file = (Path(args.review_file).resolve() if args.review_file
                   else doc.with_name(doc.stem + ".review.md"))
    try:
        review_file.relative_to(repo)
    except ValueError:
        sys.exit(f"error: review file {review_file} is outside repo {repo}")

    args.runs_dir = Path(args.runs_dir).resolve() if args.runs_dir else \
        repo / ".review-loop" / datetime.now().strftime("%Y%m%d-%H%M%S")
    args.runs_dir.mkdir(parents=True, exist_ok=True)
    (args.runs_dir / "orchestrator.pid").write_text(str(os.getpid()))

    r = Runner(args)
    r.log(f"doc={doc} review_file={review_file} repo={repo}")
    r.log(f"max_rounds={args.max_rounds} streak_limit={args.streak_limit} timeout={args.timeout}s")

    if args.branch:
        if r.git("rev-parse", "--verify", args.branch, check=False).returncode == 0:
            r.git("checkout", args.branch)
        else:
            r.git("checkout", "-b", args.branch)
        r.log(f"on branch {args.branch}")

    def dirty(path):
        return bool(r.git("status", "--porcelain", "--", str(path)).stdout.strip())

    def commit(path, msg):
        r.git("add", "--", str(path))
        r.git("commit", "-m", msg)
        r.log(f"committed: {msg}")

    names = {"A": args.name_a, "B": args.name_b}
    cmds = {"A": args.cmd_a, "B": args.cmd_b}
    modifier, streak, zero_diff_streak = "A", 0, 0
    state = "max-rounds"

    for rnd in range(1, args.max_rounds + 1):
        reviewer = "B" if modifier == "A" else "A"
        mapping = {"doc": doc, "review_file": review_file, "round": rnd,
                   "repo": repo, "model": names[modifier]}
        r.status(state="running", round=rnd, phase="modify",
                 modifier=names[modifier], reviewer=names[reviewer], doc=str(doc))

        # --- modification phase ---
        prompt = render(Path(args.prompts_dir) / "modifier.md", mapping)
        r.log(f"round {rnd}: {names[modifier]} modifying")
        rc = r.run_agent(cmds[modifier], prompt, args.timeout)
        if rc is None:
            r.log(f"round {rnd}: modifier timed out")
        if dirty(doc):
            commit(doc, f"[{names[modifier]}] 修订 - Round {rnd}")
            zero_diff_streak = 0
        else:
            zero_diff_streak += 1
            r.log(f"round {rnd}: no changes to doc (streak {zero_diff_streak})")
            if zero_diff_streak >= 2:
                state = "no-progress"
                r.log("modifier produced no changes twice in a row, stopping")
                break
            continue  # nothing changed, skip a redundant review

        # --- review phase ---
        mapping["model"] = names[reviewer]
        r.status(state="running", round=rnd, phase="review",
                 modifier=names[modifier], reviewer=names[reviewer], doc=str(doc))
        prompt = render(Path(args.prompts_dir) / "reviewer.md", mapping)
        r.log(f"round {rnd}: {names[reviewer]} reviewing")
        snap = (review_file.stat().st_mtime_ns, review_file.stat().st_size) \
            if review_file.exists() else None
        rc = r.run_agent(cmds[reviewer], prompt, args.timeout)
        if rc is None:
            r.log(f"round {rnd}: reviewer timed out")
        if dirty(review_file):
            commit(review_file, f"[{names[reviewer]}] 审核 - Round {rnd}")

        # ignore a stale verdict: the review file must have been (re)written
        # by THIS round's reviewer call, not left over from a previous run
        now = (review_file.stat().st_mtime_ns, review_file.stat().st_size) \
            if review_file.exists() else None
        fresh = now is not None and now != snap
        verdict = last_nonempty_line(review_file) if fresh else ""
        if not fresh:
            r.log(f"round {rnd}: review file not refreshed this round, verdict ignored")
        r.log(f"round {rnd}: verdict line: {verdict!r}")
        if "[PASS]" in verdict:
            state = "pass"
            r.log(f"[PASS] received from {names[reviewer]} at round {rnd}")
            break

        streak += 1
        if streak >= args.streak_limit:
            modifier = reviewer
            streak = 0
            r.log(f"role swap: next modifier is {names[modifier]}")

    # --- finalize ---
    if args.push:
        remotes = [r.strip() for r in args.push.split(",") if r.strip()]
        failed = []
        for remote in remotes:
            try:
                r.git("push", "-u", remote, "HEAD")
                r.log(f"pushed to {remote}")
            except RuntimeError as e:
                failed.append(remote)
                r.log(f"push to {remote} FAILED: {e}")
        if failed:
            r.log(f"warning: push failed for: {', '.join(failed)}")
    r.status(state=state, doc=str(doc), review_file=str(review_file))
    r.log(f"loop finished: {state}")
    sys.exit({"pass": 0, "max-rounds": 2, "no-progress": 3}[state])


if __name__ == "__main__":
    main()
