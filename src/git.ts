import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitEnv } from "./env.js";

const execFileAsync = promisify(execFile);

export interface GitOptions {
  /** Extra env, e.g. auth headers via GIT_CONFIG_* for fetches. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Runs git with the env policy from `gitEnv` (no host config, no model or GitHub credentials). */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    env: gitEnv(options.env),
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs ?? 2 * 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return stdout;
}
