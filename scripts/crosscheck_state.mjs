#!/usr/bin/env node
/**
 * crosscheck-state — deterministic state machine for the crosscheck plugin.
 *
 * The main Agent (orchestrator) calls this script after every sub-agent step;
 * all loop bookkeeping (round counter, streak, role swap, no-progress,
 * freshness check, git commits) is decided HERE, never in model memory.
 *
 * State file: <repo>/.crosscheck/<slug>.state.json  (slug = repo-relative doc
 * path with "/" replaced by "__").
 *
 * Subcommands:
 *   init           --doc <path> [--repo <path>] [--review-file <path>]
 *                    [--max-rounds N] [--streak-limit N]
 *                    [--modifier-slot primary|secondary] [--force]
 *                    [--label-primary "K3"] [--label-secondary "gpt-5.6-sol"]
 *                    [--model-primary <pool-alias|primary>] [--model-secondary <pool-alias|primary>]
 *   status         --doc <path> | --repo <path>
 *   record-modify  --doc <path>
 *   record-review  --doc <path> (--before | --after)
 *   verdict        --doc <path> | --repo <path>
 *   pause|abort|resume --doc <path> [--reason "why"]  (reason stored as state.note)
 *
 * Every command prints ONE line of JSON to stdout: {ok:true, ...} on success
 * (the `next` field tells the orchestrator what to do), or exits 1 with
 * {ok:false, error} on stdout for expected failures.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = ".crosscheck";
const TERMINAL = new Set(["pass", "max-rounds", "no-progress", "aborted"]);

// ---------------------------------------------------------------- util

function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") { args.force = true; continue; }
    if (a === "--before") { args.before = true; continue; }
    if (a === "--after") { args.after = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 >= argv.length) fail(`missing value for ${a}`);
      args[key] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

function git(repo, ...gitArgs) {
  try {
    return execFileSync("git", ["-C", repo, ...gitArgs], { encoding: "utf8" }).trim();
  } catch (e) {
    const stderr = (e.stderr || "").toString().trim();
    throw new Error(`git ${gitArgs.join(" ")} failed: ${stderr || e.message}`);
  }
}

function findRepo(fromDir) {
  return git(fromDir, "rev-parse", "--show-toplevel");
}

function isDirty(repo, relPath) {
  return git(repo, "status", "--porcelain", "--", relPath) !== "";
}

function commitFile(repo, relPath, msg) {
  git(repo, "add", "--", relPath);
  git(repo, "commit", "-m", msg);
}

/** (mtime_ns, size) snapshot used to detect whether the reviewer rewrote the file. */
function snapOf(absPath) {
  try {
    const st = fs.statSync(absPath, { bigint: true });
    return { mtime_ns: st.mtimeNs.toString(), size: Number(st.size) };
  } catch {
    return null; // file does not exist
  }
}

function sameSnap(a, b) {
  if (a === null || b === null) return a === b;
  return a.mtime_ns === b.mtime_ns && a.size === b.size;
}

function lastNonemptyLine(absPath) {
  try {
    const lines = fs.readFileSync(absPath, "utf8")
      .split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : "";
  } catch {
    return "";
  }
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- state io

function slugFor(relDocPath) {
  return relDocPath.split(path.sep).join("__") + ".state.json";
}

function statePath(repo, relDocPath) {
  return path.join(repo, STATE_DIR, slugFor(relDocPath));
}

function loadState(file) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`cannot read state file ${file}: ${e.message}`);
  }
  return st;
}

function saveState(file, st) {
  st.updated_at = nowIso();
  fs.writeFileSync(file, JSON.stringify(st, null, 2) + "\n", "utf8");
}

function requireRunning(st) {
  if (st.status !== "running") {
    fail(`loop for ${st.doc} is not running (status=${st.status}); resume it first if paused`);
  }
}

function otherSlot(slot) {
  return slot === "primary" ? "secondary" : "primary";
}

/** Human-readable model name for a slot, e.g. "K3" instead of "primary". */
function labelOf(st, slot) {
  return (st.labels && st.labels[slot]) || slot;
}

/** Resolve --doc against cwd, find repo, return {repo, relDoc, absDoc}. */
function resolveDoc(args) {
  if (!args.doc) fail("missing --doc <path>");
  const absDoc = path.resolve(process.cwd(), args.doc);
  const repo = args.repo
    ? path.resolve(process.cwd(), args.repo)
    : findRepo(path.dirname(absDoc));
  const relDoc = path.relative(repo, absDoc);
  if (relDoc.startsWith("..")) fail(`doc ${absDoc} is outside repo ${repo}`);
  return { repo, relDoc, absDoc };
}

function listStates(repo) {
  const dir = path.join(repo, STATE_DIR);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".state.json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch {
      // corrupted state file: skip (hooks are fail-open; humans can inspect)
    }
  }
  return out.sort((a, b) => (a.doc || "").localeCompare(b.doc || ""));
}

// ---------------------------------------------------------------- commands

function cmdInit(args) {
  const { repo, relDoc, absDoc } = resolveDoc(args);
  if (!fs.existsSync(absDoc)) fail(`doc not found: ${absDoc}`);

  const absReview = args["review-file"]
    ? path.resolve(process.cwd(), args["review-file"])
    : path.join(path.dirname(absDoc), path.basename(absDoc, path.extname(absDoc)) + ".review.md");
  const relReview = path.relative(repo, absReview);
  if (relReview.startsWith("..")) fail(`review file ${absReview} is outside repo ${repo}`);

  const file = statePath(repo, relDoc);
  if (fs.existsSync(file) && !args.force) {
    const old = loadState(file);
    if (!TERMINAL.has(old.status)) {
      fail(`state file already exists with status=${old.status} (use --force to reinit, or resume/pause/abort it): ${file}`);
    }
  }

  const modifierSlot = args["modifier-slot"] || "primary";
  if (!["primary", "secondary"].includes(modifierSlot)) {
    fail(`--modifier-slot must be primary|secondary, got ${modifierSlot}`);
  }
  // Optional human-readable model names per slot (confirmed with the user at
  // loop start); used in commit messages and status output.
  const labels = {};
  if (args["label-primary"]) labels.primary = args["label-primary"];
  if (args["label-secondary"]) labels.secondary = args["label-secondary"];
  // Optional dispatch model per slot (0.36+ subagent model pool era): the
  // exact value the orchestrator passes as `model:` when spawning that slot's
  // sub-agent — a pool alias (e.g. "chatgpt-local/gpt-5.6-sol") or the symbol
  // "primary"/"secondary" (legacy two-slot behavior, the default).
  const models = {
    primary: args["model-primary"] || "primary",
    secondary: args["model-secondary"] || "secondary",
  };
  // Display labels default to the dispatch alias when not given explicitly.
  if (!labels.primary) labels.primary = models.primary;
  if (!labels.secondary) labels.secondary = models.secondary;
  const st = {
    version: 1,
    doc: relDoc,
    review_file: relReview,
    repo,
    state_file: path.relative(repo, file),
    round: 1,
    phase: "modify", // modify | review | done
    modifier_slot: modifierSlot,
    labels,
    models,
    streak: 0,
    zero_diff_streak: 0,
    max_rounds: parseInt(args["max-rounds"] || "10", 10),
    streak_limit: parseInt(args["streak-limit"] || "2", 10),
    status: "running", // running | paused | pass | max-rounds | no-progress | aborted
    review_snapshot: null,
    verdicts: [],
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (!Number.isInteger(st.max_rounds) || st.max_rounds < 1) fail("--max-rounds must be a positive integer");
  if (!Number.isInteger(st.streak_limit) || st.streak_limit < 1) fail("--streak-limit must be a positive integer");

  fs.mkdirSync(path.dirname(file), { recursive: true });
  saveState(file, st);
  print(st, { next: "modify" });
}

function cmdStatus(args) {
  if (args.repo && !args.doc) {
    const repo = path.resolve(process.cwd(), args.repo);
    print({ repo, loops: listStates(repo) });
    return;
  }
  const { repo, relDoc } = resolveDoc(args);
  print(loadState(statePath(repo, relDoc)));
}

function cmdRecordModify(args) {
  const { repo, relDoc } = resolveDoc(args);
  const file = statePath(repo, relDoc);
  const st = loadState(file);
  requireRunning(st);
  if (st.phase !== "modify") fail(`expected phase=modify, got ${st.phase} (doc ${relDoc})`);

  if (isDirty(repo, relDoc)) {
    commitFile(repo, relDoc, `[crosscheck] 修订 (${labelOf(st, st.modifier_slot)}) - Round ${st.round}`);
    st.zero_diff_streak = 0;
    st.phase = "review";
    saveState(file, st);
    print(st, { next: "review", changed: true });
    return;
  }

  st.zero_diff_streak += 1;
  if (st.zero_diff_streak >= 2) {
    st.status = "no-progress";
    st.phase = "done";
    saveState(file, st);
    print(st, { next: "done:no-progress", changed: false });
    return;
  }
  if (st.round >= st.max_rounds) {
    st.status = "max-rounds";
    st.phase = "done";
    saveState(file, st);
    print(st, { next: "done:max-rounds", changed: false });
    return;
  }
  st.round += 1; // same modifier retries on the next round; review is skipped
  saveState(file, st);
  print(st, { next: "modify", changed: false });
}

function cmdRecordReview(args) {
  if (!args.before && !args.after) fail("record-review needs --before or --after");
  const { repo, relDoc } = resolveDoc(args);
  const file = statePath(repo, relDoc);
  const st = loadState(file);
  requireRunning(st);
  if (st.phase !== "review") fail(`expected phase=review, got ${st.phase} (doc ${relDoc})`);
  const absReview = path.join(repo, st.review_file);

  if (args.before) {
    st.review_snapshot = snapOf(absReview);
    saveState(file, st);
    print(st, { next: "review-agent" });
    return;
  }

  // --after: freshness check, verdict parse, commit, advance the machine
  const now = snapOf(absReview);
  const fresh = now !== null && !sameSnap(now, st.review_snapshot);
  const line = fresh ? lastNonemptyLine(absReview) : "";
  const verdict = line.includes("[PASS]") ? "PASS" : line.includes("[FAIL]") ? "FAIL" : "NONE";
  const reviewerSlot = otherSlot(st.modifier_slot);

  if (isDirty(repo, st.review_file)) {
    commitFile(repo, st.review_file, `[crosscheck] 审核 (${labelOf(st, reviewerSlot)}) - Round ${st.round}`);
  }
  st.verdicts.push({
    round: st.round,
    reviewer_slot: reviewerSlot,
    verdict,
    fresh,
    line: line.slice(0, 200),
    at: nowIso(),
  });
  st.review_snapshot = null;

  if (fresh && verdict === "PASS") {
    st.status = "pass";
    st.phase = "done";
    saveState(file, st);
    print(st, { next: "done:pass", verdict });
    return;
  }

  st.streak += 1;
  let swapped = false;
  if (st.streak >= st.streak_limit) {
    st.modifier_slot = reviewerSlot; // role swap
    st.streak = 0;
    swapped = true;
  }
  if (st.round >= st.max_rounds) {
    st.status = "max-rounds";
    st.phase = "done";
    saveState(file, st);
    print(st, { next: "done:max-rounds", verdict, swapped });
    return;
  }
  st.round += 1;
  st.phase = "modify";
  saveState(file, st);
  print(st, { next: "modify", verdict, swapped });
}

function cmdVerdict(args) {
  const summarize = (st) => ({
    doc: st.doc,
    status: st.status,
    round: st.round,
    phase: st.phase,
    modifier_slot: st.modifier_slot,
    modifier: labelOf(st, st.modifier_slot),
    labels: st.labels || {},
    models: st.models || { primary: "primary", secondary: "secondary" },
    note: st.note || null,
    last_verdict: st.verdicts.length ? st.verdicts[st.verdicts.length - 1] : null,
  });
  if (args.repo && !args.doc) {
    const repo = path.resolve(process.cwd(), args.repo);
    print({ repo, loops: listStates(repo).map(summarize) });
    return;
  }
  const { repo, relDoc } = resolveDoc(args);
  print(summarize(loadState(statePath(repo, relDoc))));
}

function cmdSetStatus(args, status) {
  const { repo, relDoc } = resolveDoc(args);
  const file = statePath(repo, relDoc);
  const st = loadState(file);

  if (status === "paused" && st.status !== "running") {
    fail(`can only pause a running loop (current status=${st.status})`);
  }
  if (status === "aborted" && TERMINAL.has(st.status)) {
    fail(`loop already finished (status=${st.status})`);
  }
  if (status === "running" && st.status !== "paused") {
    fail(`can only resume a paused loop (current status=${st.status})`);
  }
  st.status = status;
  if (status === "aborted") st.phase = "done";
  // Optional human note explaining WHY the loop was paused/aborted (e.g.
  // "429 quota exhausted, wait for 5h window reset"); shown by verdict and
  // the session-start hook. Cleared on resume.
  if (status === "running") {
    delete st.note;
  } else if (args.reason) {
    st.note = args.reason;
  }
  saveState(file, st);
  print(st, { next: status === "running" ? st.phase : `done:${status}` });
}

// ---------------------------------------------------------------- main

function print(obj, extra) {
  process.stdout.write(JSON.stringify({ ok: true, ...obj, ...extra }) + "\n");
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case "init": return cmdInit(args);
      case "status": return cmdStatus(args);
      case "record-modify": return cmdRecordModify(args);
      case "record-review": return cmdRecordReview(args);
      case "verdict": return cmdVerdict(args);
      case "pause": return cmdSetStatus(args, "paused");
      case "abort": return cmdSetStatus(args, "aborted");
      case "resume": return cmdSetStatus(args, "running");
      default:
        fail(`unknown subcommand: ${cmd || "(none)"}; expected init|status|record-modify|record-review|verdict|pause|abort|resume`);
    }
  } catch (e) {
    fail(e.message);
  }
}

main();
