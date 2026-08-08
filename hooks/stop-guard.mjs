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
  const cwd = payload.cwd || process.cwd();

  const stateDir = findStateDir(cwd);
  if (!stateDir) process.exit(0);

  const loops = runningLoops(stateDir);
  if (loops.length === 0) process.exit(0);

  const script = path.join(process.env.KIMI_PLUGIN_ROOT || ".", "scripts", "crosscheck_state.mjs");
  const lines = loops.map((l) => `  - ${l.doc}  Round ${l.round}  phase=${l.phase}  (${l.file})`);
  console.error(
    `[crosscheck] 审核循环未到达终态，不能收工：\n${lines.join("\n")}\n` +
    `继续推进：读取状态文件，按 crosscheck skill 流程执行下一步（状态脚本：node ${script}）。\n` +
    `若用户已明确要求停止/跳过，先执行 node ${script} pause --doc <文档> 或 abort --doc <文档>，再收工。`
  );
  process.exit(2);
}

main().catch(() => process.exit(0)); // fail-open
