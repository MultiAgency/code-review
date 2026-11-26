import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  query as sdkQuery,
  type EffortLevel,
  type HookCallback,
  type SDKAssistantMessageError,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { claudeEnv, redactSecrets } from "./env.js";
import { REVIEW_MODE } from "./prompts.js";

export type AgentFailureKind =
  /** The account's usage limit; `retryAt` says when it resets, when Claude said. */
  | "usage_limit"
  /** The token was rejected: expired, revoked, or the account can't be used. */
  | "auth_rejected"
  /** Claude's API was overloaded or failing; worth trying again later. */
  | "overloaded"
  /** The prompt (the PR) doesn't fit in Claude's context. */
  | "too_large"
  | "budget_exceeded"
  | "turn_limit"
  | "bad_output"
  | "timeout"
  | "aborted"
  | "crashed";

export type AgentResult<T> =
  | { ok: true; data: T; costUsd: number }
  | {
      ok: false;
      failure: AgentFailureKind;
      detail: string;
      costUsd: number;
      /** For `usage_limit`: when the limit resets (epoch ms). */
      retryAt?: number;
    };

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
  /** Claude subscription token for this runner; unset uses the environment's own login or key. */
  oauthToken?: string;
  /** Anthropic API key for this runner, billed instead of any subscription token. */
  apiKey?: string;
  /** Where `apiKey` is accepted, when that is a gateway serving the Messages API. */
  baseUrl?: string;
  /** Unset = Claude Code's default model for the account. */
  model?: string;
  effort: EffortLevel;
  maxBudgetUsd: number;
  maxTurns: number;
  timeoutMs: number;
  /** After an interrupt, how long Claude gets to stop before its process is killed. Default 10s. */
  interruptGraceMs?: number;
  /** The SDK's `query`; tests replace it with a scripted message stream. */
  query?: typeof sdkQuery;
}

const TOOLS = ["Read", "Grep", "Glob"];
/** How much of Claude Code's stderr a crash keeps, from the end. */
const STDERR_TAIL = 1_500;
// The SDK delivers `outputFormat` results through this end-turn tool.
const OUTPUT_TOOL = "StructuredOutput";

/**
 * The production adapter: a Claude Code process via the Agent SDK, locked down
 * to read-only tools inside `roots`, with nothing loaded from disk or the PR.
 */
export function sdkAgentRunner(options: SdkAgentOptions): AgentRunner {
  const query = options.query ?? sdkQuery;
  return {
    async run<T>(request: AgentRequest<T>): Promise<AgentResult<T>> {
      let stderr = "";
      const result = await runPass(request, (data) => {
        stderr = (stderr + data).slice(-STDERR_TAIL);
      });
      // A crash says little by itself; the end of Claude Code's stderr usually says why.
      if (result.ok || result.failure !== "crashed" || !stderr.trim())
        return result;
      const tail = redactSecrets(stderr)
        .split(options.oauthToken || options.apiKey || "\0")
        .join("[redacted]");
      return { ...result, detail: `${result.detail}\nstderr: ${tail.trim()}` };
    },
  };

  async function runPass<T>(
    request: AgentRequest<T>,
    onStderr: (data: string) => void,
  ): Promise<AgentResult<T>> {
    const abortController = new AbortController();
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    if (signal.aborted) abortController.abort();
    // The prompt is streamed in as one message, which is what lets a pass be
    // interrupted: Claude then ends with a result that carries the cost so far,
    // where killing the process loses it. Input ends once the result arrives.
    let endInput!: () => void;
    const inputEnded = new Promise<void>((resolve) => (endInput = resolve));
    const input = (async function* (): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        message: { role: "user", content: request.prompt },
        parent_tool_use_id: null,
      };
      await inputEnded;
    })();

    const jsonSchema = z.toJSONSchema(request.schema) as Record<
      string,
      unknown
    >;
    delete jsonSchema.$schema;

    let result: SDKResultMessage | undefined;
    // What Claude said about a failed API call, before the result reports it.
    const api: ApiSignals = {};
    let stop = () => {};
    try {
      const q = query({
        prompt: input,
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
          // (Checked live for streamed prompts too.)
          verbatimPrompts: true,
          persistSession: false,
          env: claudeEnv(options),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: REVIEW_MODE,
          },
          outputFormat: { type: "json_schema", schema: jsonSchema },
          maxBudgetUsd: Math.min(
            options.maxBudgetUsd,
            request.maxBudgetUsd ?? Infinity,
          ),
          maxTurns: options.maxTurns,
          abortController,
          stderr: onStderr,
        },
      });
      stop = () => {
        q.interrupt().catch(() => abortController.abort());
        setTimeout(
          () => abortController.abort(),
          options.interruptGraceMs ?? 10_000,
        ).unref();
      };
      if (signal.aborted) abortController.abort();
      else signal.addEventListener("abort", stop, { once: true });
      for await (const message of q) {
        if (message.type === "result") {
          result = message;
          endInput();
        } else if (message.type === "assistant" && message.error)
          api.error = message.error;
        else if (
          message.type === "rate_limit_event" &&
          message.rate_limit_info.status === "rejected"
        )
          api.resetsAt = message.rate_limit_info.resetsAt;
      }
    } catch (error) {
      // The stream can throw after delivering the result (the CLI exits non-zero
      // on error results), so a result that already arrived decides the outcome.
      if (!result || signal.aborted) {
        const failure = timeout.aborted
          ? "timeout"
          : signal.aborted
            ? "aborted"
            : "crashed";
        return {
          ok: false,
          failure,
          detail: errorText(error),
          costUsd: result?.total_cost_usd ?? 0,
        };
      }
    } finally {
      endInput();
      signal.removeEventListener("abort", stop);
    }
    if (signal.aborted)
      return {
        ok: false,
        failure: timeout.aborted ? "timeout" : "aborted",
        detail: "Stopped before Claude finished.",
        costUsd: result?.total_cost_usd ?? 0,
      };

    if (!result)
      return {
        ok: false,
        failure: "crashed",
        detail: "Claude exited without a result.",
        costUsd: 0,
      };
    const costUsd = result.total_cost_usd;
    // The CLI (2.1.304) reports a prompt over the context window as `blocking_limit`
    // (see test/fixtures/sdk/too-long.ndjson); `prompt_too_long` is the documented name.
    if (
      result.terminal_reason === "prompt_too_long" ||
      result.terminal_reason === "blocking_limit"
    )
      return {
        ok: false,
        failure: "too_large",
        detail: "The prompt is too long for Claude's context.",
        costUsd,
      };
    switch (result.subtype) {
      case "error_max_budget_usd":
        return {
          ok: false,
          failure: "budget_exceeded",
          detail: result.errors.join("; "),
          costUsd,
        };
      case "error_max_turns":
        return {
          ok: false,
          failure: "turn_limit",
          detail: result.errors.join("; "),
          costUsd,
        };
      case "error_max_structured_output_retries":
        return {
          ok: false,
          failure: "bad_output",
          detail: result.errors.join("; "),
          costUsd,
        };
      case "error_during_execution":
        return {
          ...apiFailure(api),
          ok: false,
          detail: result.errors.join("; "),
          costUsd,
        };
      case "success": {
        if (result.is_error) {
          api.status = result.api_error_status ?? undefined;
          return {
            ...apiFailure(api),
            ok: false,
            detail: `API error ${api.status ?? "?"}: ${result.result}`,
            costUsd,
          };
        }
        const parsed = request.schema.safeParse(result.structured_output);
        if (!parsed.success)
          return {
            ok: false,
            failure: "bad_output",
            detail: parsed.error.message,
            costUsd,
          };
        return { ok: true, data: parsed.data, costUsd };
      }
    }
  }
}

interface ApiSignals {
  status?: number | undefined;
  error?: SDKAssistantMessageError;
  /** From a rejected rate_limit_event, in epoch seconds. */
  resetsAt?: number | undefined;
}

const AUTH_ERRORS: SDKAssistantMessageError[] = [
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
];

/** Classifies a failed API call from Claude's typed signals, falling back to the HTTP status. */
function apiFailure(api: ApiSignals): {
  failure: AgentFailureKind;
  retryAt?: number;
} {
  if (
    api.resetsAt !== undefined ||
    api.error === "rate_limit" ||
    api.status === 429
  )
    return {
      failure: "usage_limit",
      ...(api.resetsAt !== undefined ? { retryAt: api.resetsAt * 1000 } : {}),
    };
  if (
    (api.error && AUTH_ERRORS.includes(api.error)) ||
    api.status === 401 ||
    api.status === 403
  )
    return { failure: "auth_rejected" };
  if (
    api.error === "overloaded" ||
    api.error === "server_error" ||
    (api.status !== undefined && api.status >= 500)
  )
    return { failure: "overloaded" };
  return { failure: "crashed" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A path with every symlink resolved, also for a file that doesn't exist yet: the nearest folder that exists is
 * resolved and the rest appended. What doesn't exist can't be a symlink, so nothing is left unresolved.
 */
function realOrMissing(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOrMissing(parent), basename(path));
  }
}

/**
 * Denies any tool call that reaches outside the given directories, resolving
 * symlinks so a link committed in the PR (e.g. to /proc/self/environ) can't escape.
 */
export function confineToRoots(roots: string[]): HookCallback {
  const realRoots = roots.map((r) => realpathSync(r));
  const inside = (path: string) => {
    const real = realOrMissing(resolve(path));
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
    if (!TOOLS.includes(input.tool_name))
      return deny(`${input.tool_name} is not available in review mode.`);
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
        if (
          typeof value === "string" &&
          (isAbsolute(value) || value.startsWith("~") || value.includes(".."))
        ) {
          return deny(`${key} must be relative to the repository.`);
        }
      }
    }
    return {};
  };
}
