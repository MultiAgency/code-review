import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway git repo: `commit(files)` writes files and commits, returning the SHA. */
export function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "review-test-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { cwd: dir, encoding: "utf8" },
    ).trim();
  git("init", "-q", "-b", "main");
  return {
    dir,
    git,
    commit(files: Record<string, string>, message = "change") {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    },
  };
}
