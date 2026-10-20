import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { confineToRoots } from "../src/agent.ts";

const root = mkdtempSync(join(tmpdir(), "guard-"));
const repo = join(root, "repo");
mkdirSync(repo);
writeFileSync(join(repo, "ok.ts"), "x");
symlinkSync("/etc/passwd", join(repo, "evil"));
const guard = confineToRoots([repo, root]);

async function decision(tool_name: string, tool_input: Record<string, unknown>) {
  const out = (await guard(
    { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: repo } as never,
    "t",
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } };
  return out.hookSpecificOutput?.permissionDecision ?? "pass";
}

test("allows reads inside the roots", async () => {
  assert.equal(await decision("Read", { file_path: join(repo, "ok.ts") }), "pass");
  assert.equal(await decision("Read", { file_path: "ok.ts" }), "pass");
  assert.equal(await decision("Read", { file_path: join(root, "pr.diff") }), "pass");
  assert.equal(await decision("Grep", { pattern: "../anything", path: "." }), "pass");
  assert.equal(await decision("Glob", { pattern: "src/**/*.ts" }), "pass");
});

test("denies escapes", async () => {
  assert.equal(await decision("Read", { file_path: "/proc/self/environ" }), "deny");
  assert.equal(await decision("Read", { file_path: "../../etc/passwd" }), "deny");
  assert.equal(await decision("Read", { file_path: join(repo, "evil") }), "deny");
  assert.equal(await decision("Grep", { pattern: "x", path: "/home" }), "deny");
  assert.equal(await decision("Grep", { pattern: "x", glob: "../../**" }), "deny");
  assert.equal(await decision("Glob", { pattern: "/etc/*" }), "deny");
  assert.equal(await decision("Bash", { command: "env" }), "deny");
  // Grep/Glob expand `~` after the hook runs (found in live probes).
  assert.equal(await decision("Grep", { pattern: "x", path: "~/.cache" }), "deny");
  assert.equal(await decision("Glob", { pattern: "*", path: "~" }), "deny");
  assert.equal(await decision("Read", { file_path: "~/.ssh/id_ed25519" }), "deny");
  assert.equal(await decision("Glob", { pattern: "~/*" }), "deny");
  assert.equal(await decision("Glob", { pattern: "{..,x}/*" }), "deny");
  assert.equal(await decision("Grep", { pattern: "x", glob: "{../outside,src}/**" }), "deny");
});
