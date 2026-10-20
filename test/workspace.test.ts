import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openLocalWorkspace, openPullRequestWorkspace, type Workspace } from "../src/workspace.ts";
import { gitRepo } from "./support/git-repo.ts";

const opened: Workspace[] = [];
after(() => Promise.all(opened.map((w) => w.dispose())));
const track = (w: Workspace) => (opened.push(w), w);

/** A repo with a main branch and a PR head, served like GitHub via file://. */
function githubLike() {
  const repo = gitRepo();
  const base = repo.commit({ "src/a.ts": "a\n", "REVIEW.md": "base rules\n" }, "base");
  repo.git("checkout", "-q", "-b", "feature");
  const head = repo.commit({ "src/a.ts": "a\nb\n", "REVIEW.md": "PR rewrote the rules\n" }, "pr");
  repo.git("update-ref", "refs/pull/1/head", head);
  repo.git("checkout", "-q", "main");
  return { ...repo, base, head, cloneUrl: `file://${repo.dir}` };
}

test("PR workspace checks out the head and reads instructions from the base branch", async () => {
  const gh = githubLike();
  const ws = track(
    await openPullRequestWorkspace({ cloneUrl: gh.cloneUrl, baseRef: "main", headSha: gh.head, diffBase: gh.base, gitEnv: {} }),
  );
  assert.equal(readFileSync(join(ws.repoDir, "src/a.ts"), "utf8"), "a\nb\n");
  assert.deepEqual(await ws.instructions(), [{ name: "REVIEW.md", text: "base rules" }]);
  const diff = await ws.diff();
  assert.deepEqual(
    diff.files.map((f) => f.path),
    ["REVIEW.md", "src/a.ts"],
  );
  assert.deepEqual([...diff.commentable.get("src/a.ts")!], [1, 2]);
});

test("PR workspace survives the PR ref moving after the event (fetches the head by SHA)", async () => {
  const gh = githubLike();
  gh.git("checkout", "-q", "feature");
  const newer = gh.commit({ "src/a.ts": "a\nb\nc\n" }, "pushed later");
  gh.git("update-ref", "refs/pull/1/head", newer);
  gh.git("checkout", "-q", "main");
  const ws = track(
    await openPullRequestWorkspace({ cloneUrl: gh.cloneUrl, baseRef: "main", headSha: gh.head, diffBase: gh.base, gitEnv: {} }),
  );
  assert.equal(readFileSync(join(ws.repoDir, "src/a.ts"), "utf8"), "a\nb\n");
});

test("incremental diff covers only commits after the previous head", async () => {
  const gh = githubLike();
  gh.git("checkout", "-q", "feature");
  const newer = gh.commit({ "src/b.ts": "new\n" }, "second push");
  gh.git("checkout", "-q", "main");
  const ws = track(
    await openPullRequestWorkspace({ cloneUrl: gh.cloneUrl, baseRef: "main", headSha: newer, diffBase: gh.head, gitEnv: {} }),
  );
  assert.deepEqual(
    (await ws.diff()).files.map((f) => f.path),
    ["src/b.ts"],
  );
});

test("file names with spaces, quotes, tabs and unicode; renames, deletions, binaries, mode changes", async () => {
  const repo = gitRepo();
  writeFileSync(join(repo.dir, "mode.sh"), "echo\n");
  const base = repo.commit({ "old.ts": "x\n".repeat(20), "gone.ts": "bye\n", "mode.sh": "echo\n" }, "base");
  repo.git("mv", "old.ts", "renamed.ts");
  repo.git("rm", "-q", "gone.ts");
  execFileSync("chmod", ["+x", join(repo.dir, "mode.sh")]);
  writeFileSync(join(repo.dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
  const head = repo.commit({
    "my file.ts": "s\n",
    'quote"name.ts': "q\n",
    "tab\tname.ts": "t\n",
    "ünïcode.ts": "u\n",
    "renamed.ts": "x\n".repeat(20) + "added\n",
  });
  const ws = track(await openLocalWorkspace({ repoDir: repo.dir, base, head }));
  const diff = await ws.diff();
  const byPath = new Map(diff.files.map((f) => [f.path, f]));
  assert.equal(byPath.get("renamed.ts")?.status, "renamed");
  assert.equal(byPath.get("renamed.ts")?.previousPath, "old.ts");
  assert.equal(byPath.get("gone.ts")?.status, "deleted");
  assert.equal(byPath.get("mode.sh")?.status, "modified");
  assert.equal(byPath.get("bin.dat")?.status, "added");
  for (const name of ["my file.ts", 'quote"name.ts', "tab\tname.ts", "ünïcode.ts"]) {
    assert.deepEqual([...(diff.commentable.get(name) ?? [])], [1], name);
  }
  assert.ok(diff.commentable.get("renamed.ts")?.has(21));
});

test("host git config can't change the diff format", async () => {
  const repo = gitRepo();
  const base = repo.commit({ "b/x.ts": "1\n" });
  const head = repo.commit({ "b/x.ts": "1\n2\n" });
  const cfg = join(mkdtempSync(join(tmpdir(), "gitcfg-")), "config");
  writeFileSync(cfg, "[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  try {
    const ws = track(await openLocalWorkspace({ repoDir: repo.dir, base, head }));
    assert.deepEqual([...(await ws.diff()).commentable.keys()], ["b/x.ts"]);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});

test("lockfiles, build output and vendored code are skipped", async () => {
  const repo = gitRepo();
  const base = repo.commit({ "src/a.ts": "a\n" });
  const head = repo.commit({
    "src/a.ts": "a\nb\n",
    "package-lock.json": "{}\n",
    "dist/out.js": "x\n",
    "web/app.min.js": "x\n",
    "vendor/lib/x.go": "x\n",
  });
  const ws = track(await openLocalWorkspace({ repoDir: repo.dir, base, head }));
  const diff = await ws.diff();
  assert.deepEqual(diff.files.map((f) => f.path), ["src/a.ts"]);
  assert.deepEqual(diff.skipped.sort(), ["dist/out.js", "package-lock.json", "vendor/lib/x.go", "web/app.min.js"]);
  assert.doesNotMatch(diff.text, /package-lock/);
});

test("local workspace reviews the commit, not uncommitted edits, and cleans up", async () => {
  const repo = gitRepo();
  const base = repo.commit({ "a.ts": "1\n" });
  const head = repo.commit({ "a.ts": "1\n2\n" });
  writeFileSync(join(repo.dir, "a.ts"), "dirty\n");
  const ws = await openLocalWorkspace({ repoDir: repo.dir, base, head });
  assert.equal(readFileSync(join(ws.repoDir, "a.ts"), "utf8"), "1\n2\n");
  await ws.dispose();
  assert.ok(!existsSync(ws.workDir));
  assert.doesNotMatch(repo.git("worktree", "list"), /pr-review-/);
});

test("local workspace explains a missing merge base", async () => {
  const repo = gitRepo();
  repo.commit({ "a.ts": "1\n" });
  repo.git("checkout", "-q", "--orphan", "other");
  const other = repo.commit({ "b.ts": "2\n" });
  await assert.rejects(openLocalWorkspace({ repoDir: repo.dir, base: "main", head: other }), /fetch-depth: 0/);
});

test("instructions follow @imports from the base branch, safely", async () => {
  const repo = gitRepo();
  const base = repo.commit(
    {
      "CLAUDE.md": "@AGENTS.md\n",
      "AGENTS.md": "Contracts: see @docs/rules.md and `@not-an-import.md` in code.\n",
      "docs/rules.md": "Rule #130: capture fixtures.\n@../../etc/passwd\n@/etc/passwd\n@~/.ssh/id_rsa\n@AGENTS.md\n",
      "REVIEW.md": "Passes are defined here. @docs/missing.md\n",
    },
    "base",
  );
  repo.git("checkout", "-q", "-b", "feature");
  const head = repo.commit({ "AGENTS.md": "PR rewrote the contracts\n" }, "pr");
  const ws = track(await openLocalWorkspace({ repoDir: repo.dir, base, head }));
  const found = await ws.instructions();
  assert.deepEqual(
    found.map((i) => i.name),
    ["CLAUDE.md", "AGENTS.md", "docs/rules.md", "REVIEW.md"],
  );
  assert.match(found[1]!.text, /^Contracts:/);
  assert.match(found[2]!.text, /Rule #130/);
});

test("instruction imports skip symlinks and stop at size and depth limits", async () => {
  const repo = gitRepo();
  const chain: Record<string, string> = { "CLAUDE.md": "@d1.md\n" };
  for (let i = 1; i <= 8; i++) chain[`d${i}.md`] = `level ${i}\n@d${i + 1}.md\n`;
  chain["big.md"] = "x".repeat(300_000);
  chain["REVIEW.md"] = "@big.md\n@link.md\n";
  repo.commit(chain, "base");
  execFileSync("ln", ["-s", "/etc/passwd", join(repo.dir, "link.md")]);
  repo.git("add", "link.md");
  repo.git("commit", "-q", "-m", "link");
  const ws = track(await openLocalWorkspace({ repoDir: repo.dir, base: repo.git("rev-parse", "HEAD"), head: repo.git("rev-parse", "HEAD") }));
  const names = (await ws.instructions()).map((i) => i.name);
  assert.ok(!names.includes("link.md"), "symlink followed");
  assert.ok(!names.includes("big.md"), "oversized file included");
  assert.ok(names.includes("d3.md") && !names.includes("d6.md"), `depth not capped: ${names.join(",")}`);
});

test("local workspace lists the change's commit messages, oldest first", async () => {
  const repo = gitRepo();
  const base = repo.commit({ "a.ts": "1\n" }, "base");
  repo.commit({ "a.ts": "1\n2\n" }, "first change\n\nwith a body");
  const head = repo.commit({ "a.ts": "1\n2\n3\n" }, "second change");
  const ws = track(await openLocalWorkspace({ repoDir: repo.dir, base, head }));
  assert.deepEqual(await ws.commitMessages(), ["first change\n\nwith a body", "second change"]);
});
