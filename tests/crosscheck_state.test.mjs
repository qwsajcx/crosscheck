import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/crosscheck_state.mjs");

/** Create a temp git repo with one committed doc; return paths. */
function makeRepo(t, { maxRounds, streakLimit } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "crosscheck-test-"));
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "A.md"), "# Doc A\n\ninitial content\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const run = (...args) =>
    JSON.parse(execFileSync("node", [SCRIPT, ...args], { cwd: repo, encoding: "utf8" }));
  const runErr = (...args) => {
    try {
      execFileSync("node", [SCRIPT, ...args], { cwd: repo, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      return JSON.parse(e.stdout);
    }
    throw new Error("expected command to fail");
  };
  const init = (...extra) =>
    run("init", "--doc", "docs/A.md",
      ...(maxRounds ? ["--max-rounds", String(maxRounds)] : []),
      ...(streakLimit ? ["--streak-limit", String(streakLimit)] : []),
      ...extra);
  const reviewFile = path.join(repo, "docs", "A.review.md");
  const writeReview = (verdictLine) => {
    fs.writeFileSync(reviewFile, `# Review\n\n- [MEDIUM] something\n\n${verdictLine}\n`);
    // mtime_ns resolution can make a fast rewrite look identical to the
    // snapshot; bump mtime explicitly to simulate a real later write.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(reviewFile, future, future);
  };
  const touchDoc = () => {
    fs.appendFileSync(path.join(repo, "docs", "A.md"), "more content\n");
  };
  return { repo, run, runErr, init, reviewFile, writeReview, touchDoc, git };
}

test("init creates state with defaults and refuses double init", (t) => {
  const { run, runErr, init, repo } = makeRepo(t);
  const st = init();
  assert.equal(st.ok, true);
  assert.equal(st.round, 1);
  assert.equal(st.phase, "modify");
  assert.equal(st.modifier_slot, "primary");
  assert.equal(st.status, "running");
  assert.equal(st.max_rounds, 10);
  assert.equal(st.streak_limit, 2);
  assert.equal(st.review_file, "docs/A.review.md");
  assert.equal(st.next, "modify");
  assert.ok(fs.existsSync(path.join(repo, ".crosscheck", "docs__A.md.state.json")));

  const err = runErr("init", "--doc", "docs/A.md");
  assert.equal(err.ok, false);
  assert.match(err.error, /already exists/);

  const st2 = init("--force");
  assert.equal(st2.ok, true);
  assert.equal(st2.round, 1);
});

test("record-modify commits a changed doc and moves to review phase", (t) => {
  const { run, init, touchDoc, git, repo } = makeRepo(t);
  init();
  touchDoc();
  const st = run("record-modify", "--doc", "docs/A.md");
  assert.equal(st.next, "review");
  assert.equal(st.changed, true);
  assert.equal(st.phase, "review");
  assert.equal(st.zero_diff_streak, 0);
  const log = git("log", "--oneline", "-1");
  assert.match(log, /\[crosscheck\] 修订 \(primary\) - Round 1/);
  // the managed doc is committed; .crosscheck/ is a runtime artifact left untracked
  assert.equal(git("status", "--porcelain", "--", "docs/"), "");
});

test("record-modify twice with no change ends no-progress", (t) => {
  const { run, runErr, init } = makeRepo(t);
  init();
  const st1 = run("record-modify", "--doc", "docs/A.md");
  assert.equal(st1.next, "modify");
  assert.equal(st1.round, 2);
  assert.equal(st1.zero_diff_streak, 1);
  const st2 = run("record-modify", "--doc", "docs/A.md");
  assert.equal(st2.next, "done:no-progress");
  assert.equal(st2.status, "no-progress");
  assert.equal(st2.phase, "done");
  // terminal: further record calls refuse
  const err = runErr("record-modify", "--doc", "docs/A.md");
  assert.equal(err.ok, false);
  assert.match(err.error, /not running/);
});

test("no-change on the final round ends max-rounds", (t) => {
  const { run, init } = makeRepo(t, { maxRounds: 1 });
  init();
  const st = run("record-modify", "--doc", "docs/A.md");
  assert.equal(st.status, "max-rounds");
  assert.equal(st.next, "done:max-rounds");
});

test("FAIL verdict advances round, swaps roles at streak limit", (t) => {
  const { run, init, touchDoc, writeReview } = makeRepo(t);
  init();

  // round 1: modify -> review FAIL (streak 1, no swap)
  touchDoc();
  run("record-modify", "--doc", "docs/A.md");
  run("record-review", "--doc", "docs/A.md", "--before");
  writeReview("结论: [FAIL]");
  let st = run("record-review", "--doc", "docs/A.md", "--after");
  assert.equal(st.verdict, "FAIL");
  assert.equal(st.next, "modify");
  assert.equal(st.round, 2);
  assert.equal(st.streak, 1);
  assert.equal(st.swapped, false);
  assert.equal(st.modifier_slot, "primary");

  // round 2: modify -> review FAIL (streak 2 -> swap to secondary)
  touchDoc();
  run("record-modify", "--doc", "docs/A.md");
  run("record-review", "--doc", "docs/A.md", "--before");
  writeReview("结论: [FAIL]");
  st = run("record-review", "--doc", "docs/A.md", "--after");
  assert.equal(st.swapped, true);
  assert.equal(st.modifier_slot, "secondary");
  assert.equal(st.streak, 0);
  assert.equal(st.round, 3);
  assert.equal(st.status, "running");
});

test("stale review file verdict is ignored (freshness check)", (t) => {
  const { run, init, touchDoc, writeReview, reviewFile } = makeRepo(t);
  init();

  // round 1: reviewer writes a FAIL; loop continues to round 2
  touchDoc();
  run("record-modify", "--doc", "docs/A.md");
  run("record-review", "--doc", "docs/A.md", "--before");
  writeReview("结论: [FAIL]");
  run("record-review", "--doc", "docs/A.md", "--after");

  // round 2: doc changed, but reviewer crashes without writing the file.
  // The file still holds the old FAIL; even if it held PASS it must be ignored.
  touchDoc();
  run("record-modify", "--doc", "docs/A.md");
  fs.writeFileSync(reviewFile, "# old review\n\n结论: [PASS]\n"); // leftover from a previous run, committed
  run("record-review", "--doc", "docs/A.md", "--before");
  const st = run("record-review", "--doc", "docs/A.md", "--after");
  assert.equal(st.status, "running"); // NOT pass
  const last = st.verdicts[st.verdicts.length - 1];
  assert.equal(last.fresh, false);
  assert.equal(last.verdict, "NONE");
  assert.equal(st.round, 3);
});

test("fresh PASS verdict ends the loop with status pass", (t) => {
  const { run, init, touchDoc, writeReview, git } = makeRepo(t);
  init();
  touchDoc();
  run("record-modify", "--doc", "docs/A.md");
  run("record-review", "--doc", "docs/A.md", "--before");
  writeReview("结论: [PASS]");
  const st = run("record-review", "--doc", "docs/A.md", "--after");
  assert.equal(st.next, "done:pass");
  assert.equal(st.status, "pass");
  assert.equal(st.phase, "done");
  assert.match(git("log", "--oneline", "-1"), /\[crosscheck\] 审核 \(secondary\) - Round 1/);
});

test("max-rounds reached after final FAIL review", (t) => {
  const { run, init, touchDoc, writeReview } = makeRepo(t, { maxRounds: 2 });
  init();
  let st;
  for (let i = 0; i < 2; i++) {
    touchDoc();
    run("record-modify", "--doc", "docs/A.md");
    run("record-review", "--doc", "docs/A.md", "--before");
    writeReview("结论: [FAIL]");
    st = run("record-review", "--doc", "docs/A.md", "--after");
  }
  assert.equal(st.status, "max-rounds");
  assert.equal(st.next, "done:max-rounds");
});

test("pause / resume / abort semantics", (t) => {
  const { run, runErr, init } = makeRepo(t);
  init();

  let st = run("pause", "--doc", "docs/A.md");
  assert.equal(st.status, "paused");
  assert.match(st.next, /^done:/);

  // a paused loop is not running: record calls and double-pause fail
  let err = runErr("record-modify", "--doc", "docs/A.md");
  assert.equal(err.ok, false);
  assert.match(err.error, /not running/);
  err = runErr("pause", "--doc", "docs/A.md");
  assert.match(err.error, /can only pause a running loop/);

  st = run("resume", "--doc", "docs/A.md");
  assert.equal(st.status, "running");
  assert.equal(st.next, "modify"); // back to the phase it paused in

  err = runErr("resume", "--doc", "docs/A.md");
  assert.match(err.error, /can only resume a paused loop/);

  st = run("abort", "--doc", "docs/A.md");
  assert.equal(st.status, "aborted");
  assert.equal(st.phase, "done");
  err = runErr("abort", "--doc", "docs/A.md");
  assert.match(err.error, /already finished/);
});

test("pause --reason stores a note, resume clears it", (t) => {
  const { run, init } = makeRepo(t);
  init();

  let st = run("pause", "--doc", "docs/A.md", "--reason", "429 配额耗尽，等 5 小时窗口重置");
  assert.equal(st.status, "paused");
  assert.equal(st.note, "429 配额耗尽，等 5 小时窗口重置");

  const v = run("verdict", "--doc", "docs/A.md");
  assert.equal(v.note, "429 配额耗尽，等 5 小时窗口重置");

  st = run("resume", "--doc", "docs/A.md");
  assert.equal(st.status, "running");
  assert.equal(st.note, undefined);
});

test("verdict and status commands summarize state", (t) => {
  const { run, init, touchDoc, writeReview, repo } = makeRepo(t);
  init();
  touchDoc();
  run("record-modify", "--doc", "docs/A.md");
  run("record-review", "--doc", "docs/A.md", "--before");
  writeReview("结论: [PASS]");
  run("record-review", "--doc", "docs/A.md", "--after");

  const v = run("verdict", "--doc", "docs/A.md");
  assert.equal(v.status, "pass");
  assert.equal(v.last_verdict.verdict, "PASS");

  const all = run("verdict", "--repo", repo);
  assert.equal(all.loops.length, 1);
  assert.equal(all.loops[0].doc, "docs/A.md");

  const s = run("status", "--repo", repo);
  assert.equal(s.loops.length, 1);
  assert.equal(s.loops[0].status, "pass");
});

test("init stores dispatch model aliases (pool era), labels default to them", (t) => {
  const { run, repo } = makeRepo(t);
  const st = run("init", "--doc", "docs/A.md",
    "--model-primary", "kimi-code/k3", "--model-secondary", "chatgpt-local/gpt-5.6-sol");
  assert.deepEqual(st.models, { primary: "kimi-code/k3", secondary: "chatgpt-local/gpt-5.6-sol" });
  // labels fall back to the dispatch alias for display/commit messages
  assert.deepEqual(st.labels, { primary: "kimi-code/k3", secondary: "chatgpt-local/gpt-5.6-sol" });

  const v = run("verdict", "--repo", repo);
  assert.deepEqual(v.loops[0].models, { primary: "kimi-code/k3", secondary: "chatgpt-local/gpt-5.6-sol" });

  // explicit label still wins over the alias fallback
  const st2 = run("init", "--doc", "docs/A.md", "--force",
    "--model-secondary", "chatgpt-local/gpt-5.6-sol", "--label-secondary", "GPT-5.6 Sol");
  assert.equal(st2.models.secondary, "chatgpt-local/gpt-5.6-sol");
  assert.equal(st2.labels.secondary, "GPT-5.6 Sol");
  assert.equal(st2.models.primary, "primary"); // untouched slot keeps legacy symbol
});

test("init stores model labels and commit messages use them", (t) => {
  const { run, touchDoc, writeReview, git, repo } = makeRepo(t);
  const st = run("init", "--doc", "docs/A.md",
    "--label-primary", "K3", "--label-secondary", "deepseek-flash");
  assert.deepEqual(st.labels, { primary: "K3", secondary: "deepseek-flash" });

  touchDoc();
  run("record-modify", "--doc", "docs/A.md");
  assert.match(git("log", "--oneline", "-1"), /\[crosscheck\] 修订 \(K3\) - Round 1/);

  run("record-review", "--doc", "docs/A.md", "--before");
  writeReview("结论: [FAIL]");
  const after = run("record-review", "--doc", "docs/A.md", "--after");
  assert.match(git("log", "--oneline", "-1"), /\[crosscheck\] 审核 \(deepseek-flash\) - Round 1/);

  const v = run("verdict", "--repo", repo);
  assert.equal(v.loops[0].modifier, "K3"); // slot label resolved to model name
  assert.deepEqual(v.loops[0].labels, { primary: "K3", secondary: "deepseek-flash" });
  assert.equal(after.modifier_slot, "primary");
});
