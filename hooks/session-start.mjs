#!/usr/bin/env node
/**
 * crosscheck session-start — observation hook.
 *
 * On session start/resume, looks for unfinished crosscheck loops under the
 * session's project directory and prints a one-line-per-loop reminder to
 * stdout (which the CLI may append to context). Never blocks; always exit 0.
 */
import fs from "node:fs";
import path from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(data), 3000).unref();
  });
}

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

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch { /* ignore */ }
  const cwd = payload.cwd || process.cwd();

  const stateDir = findStateDir(cwd);
  if (!stateDir) return;

  const notes = [];
  for (const f of fs.readdirSync(stateDir)) {
    if (!f.endsWith(".state.json")) continue;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(stateDir, f), "utf8"));
      if (st.status === "running" || st.status === "paused") {
        notes.push(
          `  - ${st.doc}: Round ${st.round}, phase=${st.phase}, status=${st.status}` +
          (st.status === "paused" ? "（已暂停，resume 可续跑）" : "（上次会话中断，可继续）")
        );
      }
    } catch { /* skip corrupt files */ }
  }
  if (notes.length === 0) return;

  process.stdout.write(
    `[crosscheck] 发现未完成的文档审核循环：\n${notes.join("\n")}\n` +
    `用 /crosscheck:status 查看详情；说"继续 crosscheck"即可从中断处续跑。\n`
  );
}

main().catch(() => {}).finally(() => process.exit(0));
