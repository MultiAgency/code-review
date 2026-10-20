import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { git, type GitOptions } from "./git.js";

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";

export interface ChangedFile {
  path: string;
  status: FileStatus;
  /** Set for renames and copies. */
  previousPath?: string;
}

export interface Diff {
  /** Unified diff of the reviewable files. */
  text: string;
  /** Every reviewable changed file, including deletions, renames and binaries. */
  files: ChangedFile[];
  /** Changed files left out of the review (lockfiles, build output, vendored code...). */
  skipped: string[];
  /** New-side lines GitHub accepts inline comments on, per file. */
  commentable: Map<string, Set<number>>;
}

/**
 * Everything a review needs from git. The agent reads `repoDir` (the reviewed
 * head) and `workDir` (scratch); nothing else.
 */
export interface Workspace {
  readonly repoDir: string;
  readonly workDir: string;
  /** The commit under review. */
  readonly headSha: string;
  /** The diff range, for display. */
  readonly range: string;
  diff(): Promise<Diff>;
  /**
   * CLAUDE.md and REVIEW.md from the base branch, never from the change itself,
   * plus the repo files they `@import` (followed safely, also from the base).
   */
  instructions(): Promise<Array<{ name: string; text: string }>>;
  /** The change's commit messages, oldest first; empty where history isn't fetched (PR workspaces). */
  commitMessages(): Promise<string[]>;
  dispose(): Promise<void>;
}

// Never worth reviewing: generated, vendored, or lockfiles.
const SKIP_GLOBS = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/node_modules/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
];
const EXCLUDES = SKIP_GLOBS.map((g) => `:(exclude,glob)${g}`);

// Pinned so the parser never depends on config; --no-textconv / --no-ext-diff
// stop a PR's .gitattributes from selecting a diff program.
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

const FETCH_TIMEOUT_MS = 10 * 60_000;

/**
 * A GitHub PR, fetched shallowly: the head (full tree, checked out) by SHA, so
 * a push after the event can't make the checkout fail; the base branch tip and
 * the diff base without blobs. Diffs `diffBase..head`: the merge base for a
 * full review, or the previously reviewed head for an incremental one.
 */
export async function openPullRequestWorkspace(opts: {
  cloneUrl: string;
  baseRef: string;
  headSha: string;
  /** Merge base (full review) or the last reviewed head (incremental). */
  diffBase: string;
  gitEnv: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<Workspace> {
  const workDir = await mkdtemp(join(tmpdir(), "pr-review-"));
  const repoDir = join(workDir, "repo");
  const gitOpts: GitOptions = { env: opts.gitEnv, ...(opts.signal ? { signal: opts.signal } : {}) };
  try {
    await mkdir(repoDir);
    await git(repoDir, ["init", "--quiet"], gitOpts);
    await git(repoDir, ["remote", "add", "origin", opts.cloneUrl], gitOpts);
    await git(repoDir, ["fetch", "--quiet", "--depth=1", "origin", opts.headSha], {
      ...gitOpts,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    await git(
      repoDir,
      [
        "fetch",
        "--quiet",
        "--depth=1",
        "--filter=blob:none",
        "origin",
        `+refs/heads/${opts.baseRef}:refs/review/base`,
        opts.diffBase,
      ],
      { ...gitOpts, timeoutMs: FETCH_TIMEOUT_MS },
    );
    await git(repoDir, ["checkout", "--quiet", "--detach", opts.headSha], gitOpts);
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
  return makeWorkspace({
    repoDir,
    workDir,
    headSha: opts.headSha,
    diffArgs: [`${opts.diffBase}..${opts.headSha}`],
    range: `${opts.diffBase.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
    instructionsRef: "refs/review/base",
    logRange: undefined,
    gitOpts,
    dispose: () => rm(workDir, { recursive: true, force: true }),
  });
}

/**
 * A local checkout (the CLI). The head is checked out into its own worktree,
 * so the agent reads exactly the reviewed commit, not uncommitted edits.
 */
export async function openLocalWorkspace(opts: { repoDir: string; base: string; head: string }): Promise<Workspace> {
  const gitOpts: GitOptions = {};
  const headSha = (await git(opts.repoDir, ["rev-parse", "--verify", `${opts.head}^{commit}`])).trim();
  try {
    await git(opts.repoDir, ["merge-base", opts.base, headSha]);
  } catch {
    throw new Error(
      `No merge base between ${opts.base} and ${opts.head}. In CI, fetch full history (actions/checkout fetch-depth: 0).`,
    );
  }
  const workDir = await mkdtemp(join(tmpdir(), "pr-review-"));
  const repoDir = join(workDir, "repo");
  await git(opts.repoDir, ["worktree", "add", "--quiet", "--detach", repoDir, headSha]);
  return makeWorkspace({
    repoDir,
    workDir,
    headSha,
    diffArgs: [`${opts.base}...${headSha}`],
    range: `${opts.base}...${opts.head}`,
    instructionsRef: opts.base,
    logRange: `${opts.base}..${headSha}`,
    gitOpts,
    dispose: async () => {
      await git(opts.repoDir, ["worktree", "remove", "--force", repoDir]).catch(() => {});
      await rm(workDir, { recursive: true, force: true });
    },
  });
}

function makeWorkspace(w: {
  repoDir: string;
  workDir: string;
  headSha: string;
  diffArgs: string[];
  range: string;
  instructionsRef: string;
  /** Range for commit messages, when history is available. */
  logRange: string | undefined;
  gitOpts: GitOptions;
  dispose: () => Promise<void>;
}): Workspace {
  return {
    repoDir: w.repoDir,
    workDir: w.workDir,
    headSha: w.headSha,
    range: w.range,
    async diff() {
      const all = parseNameStatus(await git(w.repoDir, ["diff", "--name-status", "-z", "-M", ...w.diffArgs], w.gitOpts));
      const kept = parseNameStatus(
        await git(w.repoDir, ["diff", "--name-status", "-z", "-M", ...w.diffArgs, "--", ".", ...EXCLUDES], w.gitOpts),
      );
      const keptPaths = new Set(kept.map((f) => f.path));
      const text = await git(w.repoDir, ["diff", ...DIFF_FLAGS, ...w.diffArgs, "--", ".", ...EXCLUDES], w.gitOpts);
      return {
        text,
        files: kept,
        skipped: all.filter((f) => !keptPaths.has(f.path)).map((f) => f.path),
        commentable: commentableLines(text),
      };
    },
    async instructions() {
      const found: Array<{ name: string; text: string }> = [];
      const seen = new Set<string>();
      let total = 0;
      const visit = async (path: string, depth: number): Promise<void> => {
        if (seen.has(path) || depth > MAX_IMPORT_DEPTH) return;
        seen.add(path);
        const text = await readRegularFile(w.repoDir, w.instructionsRef, path, w.gitOpts);
        if (!text?.trim() || text.length > MAX_INSTRUCTION_FILE || total + text.length > MAX_INSTRUCTIONS) return;
        total += text.length;
        found.push({ name: path, text: text.trim() });
        for (const target of importsOf(text, path)) await visit(target, depth + 1);
      };
      for (const name of ["CLAUDE.md", "REVIEW.md"]) await visit(name, 0);
      return found;
    },
    async commitMessages() {
      if (!w.logRange) return [];
      const out = await git(w.repoDir, ["log", "--reverse", "--format=%B%x00", w.logRange], w.gitOpts);
      return out.split("\0").map((m) => m.trim()).filter(Boolean);
    },
    dispose: w.dispose,
  };
}

const MAX_IMPORT_DEPTH = 4;
const MAX_INSTRUCTION_FILE = 100_000;
const MAX_INSTRUCTIONS = 200_000;

/**
 * `@path` imports in an instructions file, resolved against its directory.
 * Imports inside code are ignored; anything leaving the repo is dropped.
 */
function importsOf(text: string, from: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const targets: string[] = [];
  for (const match of prose.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
    const raw = match[1]!.replace(/[.,;:)]+$/, "");
    if (raw.startsWith("/") || raw.startsWith("~")) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(from), raw));
    if (resolved === ".." || resolved.startsWith("../")) continue;
    targets.push(resolved);
  }
  return targets;
}

/** A file's content at a ref, only if it is a regular file (not a symlink or submodule). */
async function readRegularFile(repoDir: string, ref: string, path: string, opts: GitOptions): Promise<string | undefined> {
  const entry = await git(repoDir, ["ls-tree", "-z", ref, "--", path], opts).catch(() => "");
  const mode = entry.split(" ")[0];
  if (mode !== "100644" && mode !== "100755") return undefined;
  return git(repoDir, ["show", `${ref}:${path}`], opts).catch(() => undefined);
}

const STATUS: Record<string, FileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};

/** `git diff --name-status -z`: raw paths, no quoting. */
function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split("\0").filter((p) => p !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]!;
    const status = STATUS[code[0]!] ?? "modified";
    if (status === "renamed" || status === "copied") {
      const previousPath = parts[i++]!;
      files.push({ path: parts[i++]!, status, previousPath });
    } else {
      files.push({ path: parts[i++]!, status });
    }
  }
  return files;
}

/** Path from a `+++ b/...` line: git C-quotes unusual names and appends a TAB to names with spaces. */
function newSidePath(header: string): string | undefined {
  let raw = header.slice(4).replace(/\t$/, "");
  if (raw === "/dev/null") return undefined;
  if (raw.startsWith('"')) raw = unquoteC(raw);
  return raw.startsWith("b/") ? raw.slice(2) : raw;
}

function unquoteC(quoted: string): string {
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 1; i < quoted.length - 1; i++) {
    const ch = quoted[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = quoted[++i]!;
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(quoted.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function commentableLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let inHunk = false;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      const path = newSidePath(raw);
      if (path !== undefined) {
        current = new Set();
        files.set(path, current);
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHunk = true;
      line = Number(hunk[1]);
      continue;
    }
    if (!inHunk || current === undefined) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) current.add(line++);
  }
  return files;
}
