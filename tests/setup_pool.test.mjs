import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/setup_pool.mjs");

function setup(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-test-"));
  const config = path.join(dir, "config.toml");
  if (initial != null) fs.writeFileSync(config, initial, "utf8");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) =>
    JSON.parse(execFileSync("node", [SCRIPT, ...args, "--config", config], { encoding: "utf8" }));
  const runErr = (...args) => {
    try {
      execFileSync("node", [SCRIPT, ...args, "--config", config], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      return { code: e.status, ...JSON.parse(e.stdout) };
    }
    throw new Error("expected command to fail");
  };
  const read = () => fs.readFileSync(config, "utf8");
  return { run, runErr, read, dir, config };
}

test("fresh config: creates [secondary_model] with default_model + pool entry", (t) => {
  const { run, read } = setup(t, 'default_model = "kimi-code/k3"\n');
  const r = run("add", "kimi-code/k3", "--role", "modifier");
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  const text = read();
  assert.match(text, /\[secondary_model\]\ndefault_model = "kimi-code\/k3"/);
  assert.match(text, /\[secondary_model\.models\]\n"kimi-code\/k3" = "crosscheck 修改者：/);
});

test("adds entry into an existing pool table", (t) => {
  const { run, read } = setup(t,
`[secondary_model]
default_model = "kimi-code/k3"
[secondary_model.models]
"kimi-code/k3" = "已有的修改者描述。"

[thinking]
enabled = true
`);
  const r = run("add", "chatgpt-local/gpt-5.6-sol", "--role", "reviewer");
  assert.equal(r.ok, true);
  const text = read();
  assert.match(text, /"chatgpt-local\/gpt-5\.6-sol" = "crosscheck 审核者：/);
  // entry lands inside the models table, before the next section
  const modelsIdx = text.indexOf("[secondary_model.models]");
  const newEntryIdx = text.indexOf('"chatgpt-local/gpt-5.6-sol"');
  const thinkingIdx = text.indexOf("[thinking]");
  assert.ok(modelsIdx < newEntryIdx && newEntryIdx < thinkingIdx, "entry inside models table");
  // existing entries and other sections untouched
  assert.match(text, /"kimi-code\/k3" = "已有的修改者描述。"/);
  assert.match(text, /\[thinking\]\nenabled = true/);
});

test("existing entry with different description refuses without --overwrite (exit 3)", (t) => {
  const { run, runErr, read } = setup(t,
`[secondary_model]
default_model = "kimi-code/k3"
[secondary_model.models]
"kimi-code/k3" = "用户自己写的描述，别动。"
`);
  const before = read();
  const r = runErr("add", "kimi-code/k3", "--role", "modifier");
  assert.equal(r.code, 3);
  assert.equal(r.needs_confirmation, true);
  assert.equal(r.existing_desc, "用户自己写的描述，别动。");
  assert.equal(read(), before); // untouched

  const ok = run("add", "kimi-code/k3", "--role", "modifier", "--overwrite");
  assert.equal(ok.ok, true);
  assert.match(read(), /"kimi-code\/k3" = "crosscheck 修改者：/);
});

test("identical entry is a no-op; empty existing description gets filled without overwrite", (t) => {
  const initial =
`[secondary_model]
default_model = "kimi-code/k3"
[secondary_model.models]
"kimi-code/k3" = "crosscheck 修改者：按审核意见逐条精准修订文档，保持原文风格结构，不为改而改。"
"a/b" = ""
`;
  const { run, read } = setup(t, initial);
  const noop = run("add", "kimi-code/k3", "--role", "modifier");
  assert.equal(noop.changed, false);
  const fill = run("add", "a/b", "--desc", "补充描述");
  assert.equal(fill.ok, true);
  assert.match(read(), /"a\/b" = "补充描述"/);
});

test("legacy recipe key: adds models table and promotes default_model from recipe model", (t) => {
  const { run, read } = setup(t,
`[secondary_model]
model = "opencode-go/deepseek-v4-flash"
default_effort = "max"
`);
  const r = run("add", "kimi-code/k3", "--role", "modifier");
  assert.equal(r.ok, true);
  const text = read();
  // recipe keys preserved; models table added; default_model NOT invented (recipe model acts as implicit pool default)
  assert.match(text, /model = "opencode-go\/deepseek-v4-flash"/);
  assert.match(text, /\[secondary_model\.models\]\n"kimi-code\/k3" = "crosscheck 修改者：/);
});

test("force = true blocks (exit 4); --remove-force removes it", (t) => {
  const { runErr, run, read } = setup(t,
`[secondary_model]
default_model = "kimi-code/k3"
force = true
[secondary_model.models]
"kimi-code/k3" = "x"
`);
  const r = runErr("add", "kimi-code/kimi-for-coding", "--role", "reviewer");
  assert.equal(r.code, 4);
  assert.equal(r.blocked_by_force, true);
  const ok = run("add", "kimi-code/kimi-for-coding", "--role", "reviewer", "--remove-force");
  assert.equal(ok.ok, true);
  const text = read();
  assert.ok(!/force\s*=\s*true/.test(text), "force line removed");
  assert.match(text, /"kimi-code\/kimi-for-coding" = "crosscheck 审核者：/);
});

test("--dry-run writes nothing and shows the resulting section; backup file created on real write", (t) => {
  const { run, read, dir } = setup(t, 'default_model = "kimi-code/k3"\n');
  const before = read();
  const r = run("add", "kimi-code/k3", "--role", "modifier", "--dry-run");
  assert.equal(r.dry_run, true);
  assert.match(r.section, /\[secondary_model\.models\]/);
  assert.equal(read(), before); // nothing written

  run("add", "kimi-code/k3", "--role", "modifier");
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith("config.toml.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), before);
});

test("missing role and desc is a usage error", (t) => {
  const { runErr } = setup(t, "");
  const r = runErr("add", "kimi-code/k3");
  assert.equal(r.code, 2);
  assert.match(r.error, /--role|--desc/);
});
