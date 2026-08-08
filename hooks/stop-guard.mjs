#!/usr/bin/env node
/**
 * crosscheck stop-guard — blocks turn end while a crosscheck loop is running.
 *
 * Reads the hook payload from stdin (needs `cwd` = session project dir),
 * walks up to find a `.crosscheck/` directory, and if any `*.state.json`
 * has status "running", exits 2 with a stderr message telling the model
 * how to continue (or how to stop cleanly).
 *
 * Fail-open by design: any error (bad JSON, missing files, corrupt state)
 * exits 0 so the user is never trapped by a broken hook.
 */
import fs from "node:fs";
import path from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    // never hang if stdin is not piped
    setTimeout(() => resolve(data), 3000).unref();
  });
}

/** Walk up from dir looking for a .crosscheck directory containing state files. */
function findStateDir(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, ".crosscheck");
    try {
      if (fs.statSync(candidate).isDirectory() &&
          fs.readdirSync(candidate).some((f) => f.endsWith(".state.json"))) {
        return candidate;
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function runningLoops(stateDir) {
  const out = [];
  for (const f of fs.readdirSync(stateDir)) {
    if (!f.endsWith(".state.json")) continue;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(stateDir, f), "utf8"));
      if (st.status === "running") {
        out.push({ file: path.join(stateDir, f), doc: st.doc, round: st.round, phase: st.phase });
      }
    } catch { /* corrupt state: skip, fail-open */ }
  }
  return out;
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch { /* no/invalid payload: nothing to guard */ }
  // Without the session's project dir there is nothing meaningful to guard
  // (our own cwd is the plugin root, never the target repo).
  if (!payload.cwd) process.exit(0);
  const cwd = payload.cwd;

  // Payload logging for field discovery (off unless explicitly enabled).
  if (process.env.CROSSCHECK_HOOK_DEBUG === "1") {
    try { fs.appendFileSync("/tmp/crosscheck-stop-payloads.jsonl", JSON.stringify(payload) + "\n"); } catch { /* ignore */ }
  }

  // Sub-agent turn-ends are not ours to drive: blocking them once caused a
  // cheap model to "comply" with the block message and usurp orchestration.
  // The Stop payload's sub-agent marker fields are not officially documented,
  // so check every plausible key conservatively; when none is present we
  // assume the main agent and keep guarding.
  const subagentMarkers = ["agent_id", "subagent_id", "agent_type", "agent_name", "parent_session_id", "is_subagent"];
  if (subagentMarkers.some((k) => payload[k])) process.exit(0);

  const stateDir = findStateDir(cwd);
  if (!stateDir) process.exit(0);

  const loops = runningLoops(stateDir);
  if (loops.length === 0) process.exit(0);

  const script = path.join(process.env.KIMI_PLUGIN_ROOT || ".", "scripts", "crosscheck_state.mjs");
  const lines = loops.map((l) => `  - ${l.doc}  Round ${l.round}  phase=${l.phase}  (${l.file})`);
  console.error(
    `[crosscheck] 审核循环未到达终态：\n${lines.join("\n")}\n` +
    `判断你的身份再行动：\n` +
    `- 如果你是子代理（任务提示词让你修改或审核文档）：本消息不是给你的。不要执行任何状态脚本/git 命令，不要派更多子代理，直接返回你的任务总结。\n` +
    `- 如果你是主会话编排器：按 crosscheck skill 继续推进（状态脚本 node ${script}）；用户已明确要求停止时，先 node ${script} pause --doc <文档> 或 abort --doc <文档> 再收工。`
  );
  process.exit(2);
}

main().catch(() => process.exit(0)); // fail-open
