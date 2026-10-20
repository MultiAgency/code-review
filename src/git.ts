import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/** `base...head` diffs against the merge base, like GitHub's PR view. */
export function prDiff(cwd: string, range: string, env?: NodeJS.ProcessEnv) {
  return git(cwd, ["diff", "--no-color", "--no-ext-diff", "-M", range], env);
}

/** A file's contents at a ref, or undefined when it doesn't exist there. */
export async function readAtRef(cwd: string, ref: string, path: string, env?: NodeJS.ProcessEnv) {
  try {
    return await git(cwd, ["show", `${ref}:${path}`], env);
  } catch {
    return undefined;
  }
}

/**
 * Lines on the new side of each file that GitHub accepts inline comments on:
 * added and context lines inside a hunk.
 */
export function commentableLines(diff: string): Map<string, Set<number>> {
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
      const path = raw.slice(4);
      if (path !== "/dev/null") {
        current = new Set();
        files.set(path.replace(/^b\//, ""), current);
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
