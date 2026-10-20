import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  query,
  type EffortLevel,
  type HookCallback,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { claudeEnv } from "./env.js";
import { REVIEW_MODE } from "./prompts.js";

export type AgentFailureKind =
  | "budget_exceeded"
  | "turn_limit"
  | "bad_output"
  | "auth_or_limit"
  | "timeout"
  | "aborted"
  | "crashed";

export type AgentResult<T> =
  | { ok: true; data: T; costUsd: number }
  | { ok: false; failure: AgentFailureKind; detail: string; costUsd: number };

export interface AgentRequest<T> {
  prompt: string;
  schema: z.ZodType<T>;
  /** Directories the agent may read; the first is also where relative paths resolve. */
  roots: string[];
  signal?: AbortSignal;
  /** Spend cap for this pass; the runner's own cap still applies if lower. */
  maxBudgetUsd?: number;
}

/** One agent pass: read-only access to `roots`, structured output matching `schema`. */
export interface AgentRunner {
  run<T>(request: AgentRequest<T>): Promise<AgentResult<T>>;
}

export interface SdkAgentOptions {
  /** Unset = Claude Code's default model for the account. */
  model?: string;
  effort: EffortLevel;
  maxBudgetUsd: number;
  maxTurns: number;
  timeoutMs: number;
}

const TOOLS = ["Read", "Grep", "Glob"];
// The SDK delivers `outputFormat` results through this end-turn tool.
const OUTPUT_TOOL = "StructuredOutput";

/**
 * The production adapter: a Claude Code process via the Agent SDK, locked down
 * to read-only tools inside `roots`, with nothing loaded from disk or the PR.
 */
export function sdkAgentRunner(options: SdkAgentOptions): AgentRunner {
  return {
    async run<T>(request: AgentRequest<T>): Promise<AgentResult<T>> {
      const abortController = new AbortController();
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      if (signal.aborted) abortController.abort();
      signal.addEventListener("abort", () => abortController.abort(), { once: true });

      const jsonSchema = z.toJSONSchema(request.schema) as Record<string, unknown>;
      delete jsonSchema.$schema;

      let result: SDKResultMessage | undefined;
      try {
        const q = query({
          prompt: request.prompt,
          options: {
            ...(options.model ? { model: options.model } : {}),
            effort: options.effort,
            cwd: request.roots[0],
            // Read-only tool surface; nothing else is even offered to the model.
            tools: TOOLS,
            allowedTools: [...TOOLS, OUTPUT_TOOL],
            permissionMode: "dontAsk",
            hooks: { PreToolUse: [{ hooks: [confineToRoots(request.roots)] }] },
            // Ignore settings, hooks, skills and MCP servers from the PR branch and the host:
            // a PR could otherwise add a .claude/settings.json hook that runs code here.
            settingSources: [],
            strictMcpConfig: true,
            // The prompt carries PR-author text. Without this the CLI expands `@path`
            // mentions in it into file attachments, which bypass the PreToolUse hook.
            verbatimPrompts: true,
            persistSession: false,
            env: claudeEnv(),
            systemPrompt: { type: "preset", preset: "claude_code", append: REVIEW_MODE },
            outputFormat: { type: "json_schema", schema: jsonSchema },
            maxBudgetUsd: Math.min(options.maxBudgetUsd, request.maxBudgetUsd ?? Infinity),
            maxTurns: options.maxTurns,
            abortController,
          },
        });
        for await (const message of q) {
          if (message.type === "result") result = message;
        }
      } catch (error) {
        // The stream can throw after delivering the result (the CLI exits non-zero
        // on error results), so a result that already arrived decides the outcome.
        if (!result || signal.aborted) {
          const failure = timeout.aborted ? "timeout" : signal.aborted ? "aborted" : "crashed";
          return { ok: false, failure, detail: errorText(error), costUsd: result?.total_cost_usd ?? 0 };
        }
      }

      if (!result) return { ok: false, failure: "crashed", detail: "Claude exited without a result.", costUsd: 0 };
      const costUsd = result.total_cost_usd;
      switch (result.subtype) {
        case "error_max_budget_usd":
          return { ok: false, failure: "budget_exceeded", detail: result.errors.join("; "), costUsd };
        case "error_max_turns":
          return { ok: false, failure: "turn_limit", detail: result.errors.join("; "), costUsd };
        case "error_max_structured_output_retries":
          return { ok: false, failure: "bad_output", detail: result.errors.join("; "), costUsd };
        case "error_during_execution":
          return { ok: false, failure: "crashed", detail: result.errors.join("; "), costUsd };
        case "success": {
          if (result.is_error) {
            const status = result.api_error_status ?? 0;
            const failure = [401, 403, 429].includes(status) ? "auth_or_limit" : "crashed";
            return { ok: false, failure, detail: `API error ${status}: ${result.result}`, costUsd };
          }
          const parsed = request.schema.safeParse(result.structured_output);
          if (!parsed.success) return { ok: false, failure: "bad_output", detail: parsed.error.message, costUsd };
          return { ok: true, data: parsed.data, costUsd };
        }
      }
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/**
 * Denies any tool call that reaches outside the given directories, resolving
 * symlinks so a link committed in the PR (e.g. to /proc/self/environ) can't escape.
 */
export function confineToRoots(roots: string[]): HookCallback {
  const realRoots = roots.map((r) => realpathSync(r));
  const inside = (path: string) => {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      real = resolve(path);
    }
    return realRoots.some((root) => {
      const rel = relative(root, real);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  };
  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });

  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (input.tool_name === OUTPUT_TOOL) return {};
    if (!TOOLS.includes(input.tool_name)) return deny(`${input.tool_name} is not available in review mode.`);
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    for (const key of ["file_path", "path"]) {
      const value = args[key];
      if (typeof value !== "string") continue;
      // Grep and Glob expand a leading `~` to HOME after this hook runs, so
      // resolving it here would wrongly treat it as a directory in the repo.
      if (value.startsWith("~") || !inside(resolve(realRoots[0]!, value))) {
        return deny(`${value} is outside the repository.`);
      }
    }
    for (const key of ["pattern", "glob"]) {
      const value = args[key];
      if (input.tool_name !== "Grep" || key === "glob") {
        // `..` is rejected anywhere, including inside braces like `{..,x}`.
        if (typeof value === "string" && (isAbsolute(value) || value.startsWith("~") || value.includes(".."))) {
          return deny(`${key} must be relative to the repository.`);
        }
      }
    }
    return {};
  };
}
