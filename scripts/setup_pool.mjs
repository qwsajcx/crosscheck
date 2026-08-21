#!/usr/bin/env node
/**
 * setup_pool — deterministic configurator for the kimi-code 0.36+ subagent
 * model pool (`[secondary_model]` in config.toml), used by the crosscheck
 * plugin's onboarding flow instead of hand-editing TOML.
 *
 *   node setup_pool.mjs add <alias> [--desc "一句话选用描述"] [--role modifier|reviewer]
 *                         [--config <path>] [--overwrite] [--remove-force] [--dry-run]
 *
 * Behavior:
 * - Creates `[secondary_model]` / `[secondary_model.models]` if absent
 *   (setting `default_model` from existing default_model → recipe `model` key
 *   → the alias being added, in that order).
 * - Default descriptions per --role; --desc overrides.
 * - An existing entry with a different non-empty description REFUSES to change
 *   without --overwrite (exit 3 = "ask the user first"); identical entry is a
 *   no-op.
 * - `force = true` blocks all changes (exit 4) unless --remove-force.
 * - Always writes a timestamped backup before modifying; --dry-run prints the
 *   resulting section and writes nothing.
 * - Result is ONE line of JSON on stdout. Exit: 0 ok/no-op, 2 usage, 3 needs
 *   confirmation, 4 blocked by force, 1 other error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DESCRIPTIONS = {
  modifier: "crosscheck 修改者：按审核意见逐条精准修订文档，保持原文风格结构，不为改而改。",
  reviewer: "crosscheck 审核者：正确性/一致性/完整性/可执行性四维严格审查，HIGH/MEDIUM/LOW 分级并落盘结论行。",
};

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--overwrite") { args.overwrite = true; continue; }
    if (a === "--remove-force") { args.removeForce = true; continue; }
    if (a === "--dry-run") { args.dryRun = true; continue; }
    if (a.startsWith("--")) {
      if (i + 1 >= argv.length) out({ ok: false, error: `missing value for ${a}` }, 2);
      args[a.slice(2)] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

/** Locate the [secondary_model] section and its [secondary_model.models] sub-table. */
function scanConfig(lines) {
  const header = /^\s*\[([^\]]+)\]\s*$/;
  let sm = null; // {start, end, defaultModelLine, modelKeyLine, forceLine, models:{start,end}|null, entries:Map}
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(header);
    if (m && m[1].trim() === "secondary_model") {
      sm = { start: i, end: lines.length, entries: new Map(), models: null };
      for (let j = i + 1; j < lines.length; j++) {
        const h = lines[j].match(header);
        if (h) {
          const name = h[1].trim();
          if (name === "secondary_model.models") {
            sm.models = { start: j, end: lines.length };
            for (let k = j + 1; k < lines.length; k++) {
              if (header.test(lines[k])) { sm.models.end = k; break; }
              const e = lines[k].match(/^\s*(?:"([^"]+)"|([\w-]+))\s*=\s*"(.*)"\s*(#.*)?$/);
              if (e) sm.entries.set(e[1] ?? e[2], { line: k, desc: e[3] });
            }
            sm.end = sm.models.end;
            break;
          }
          sm.end = j;
          break;
        }
      }
      // scan the section body (before models table / next section) for keys
      const bodyEnd = sm.models ? sm.models.start : sm.end;
      for (let j = sm.start + 1; j < bodyEnd; j++) {
        if (/^\s*default_model\s*=/.test(lines[j])) sm.defaultModelLine = j;
        if (/^\s*model\s*=/.test(lines[j])) sm.modelKeyLine = j;
        if (/^\s*force\s*=\s*true/.test(lines[j])) sm.forceLine = j;
      }
      break;
    }
  }
  return sm;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, alias] = args._;
  if (cmd !== "add" || !alias) {
    out({ ok: false, error: 'usage: setup_pool.mjs add <alias> [--role modifier|reviewer] [--desc "..."] [--overwrite] [--remove-force] [--dry-run]' }, 2);
  }
  const desc = args.desc || (args.role && DEFAULT_DESCRIPTIONS[args.role]);
  if (!desc) out({ ok: false, error: "需要 --role modifier|reviewer 或显式 --desc" }, 2);
  if (args.role && !DEFAULT_DESCRIPTIONS[args.role]) out({ ok: false, error: `unknown role ${args.role}` }, 2);

  const configPath = path.resolve(args.config || path.join(os.homedir(), ".kimi-code", "config.toml"));
  const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const lines = text.split("\n");
  const sm = scanConfig(lines);

  // force gate
  if (sm && sm.forceLine != null && !args.removeForce) {
    out({ ok: false, error: "secondary_model.force = true 存在，池选择被钉死；确认移除后加 --remove-force", blocked_by_force: true }, 4);
  }

  const existing = sm ? sm.entries.get(alias) : null;
  if (existing) {
    if (existing.desc === desc) {
      out({ ok: true, changed: false, alias, desc, note: "entry already up to date" });
    }
    if (existing.desc !== "" && !args.overwrite) {
      out({ ok: false, error: `池中已有 ${alias} 且描述不同（"${existing.desc}"）`, existing_desc: existing.desc, proposed_desc: desc, needs_confirmation: true }, 3);
    }
    lines[existing.line] = `"${alias}" = "${desc}"`;
  } else if (sm && sm.models) {
    lines.splice(sm.models.end, 0, `"${alias}" = "${desc}"`);
  } else if (sm) {
    // section exists without models table: add default_model if none, then table
    const block = [`[secondary_model.models]`, `"${alias}" = "${desc}"`];
    lines.splice(sm.end, 0, ...(sm.defaultModelLine != null || sm.modelKeyLine != null ? [] : [`default_model = "${alias}"`]), ...block);
  } else {
    const block = [`[secondary_model]`, `default_model = "${alias}"`, ``, `[secondary_model.models]`, `"${alias}" = "${desc}"`];
    if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, ...block, "");
    else lines.push("", ...block);
  }

  // remove force line if authorized (the force line sits in the section body
  // before the models table; insertions above happened after it, so the
  // scanned index is still valid)
  if (sm && sm.forceLine != null && args.removeForce) {
    lines.splice(sm.forceLine, 1);
  }

  const result = lines.join("\n");
  if (args.dryRun) {
    const probe = scanConfig(result.split("\n"));
    const section = probe ? result.split("\n").slice(probe.start, probe.end).join("\n") : result;
    out({ ok: true, dry_run: true, changed: true, alias, desc, section });
  }

  fs.writeFileSync(`${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`, text, "utf8");
  fs.writeFileSync(configPath, result, "utf8");
  out({ ok: true, changed: true, alias, desc, config: configPath, backup: true, note: "已写入；/reload 或新开会话后生效" });
}

main();
