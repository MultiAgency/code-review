// Several Claude tokens behind one agent runner: reviews take turns across them, and a token at its
// usage limit rests while the same request retries on the next one.
import { sdkAgentRunner, type AgentRequest, type AgentResult, type AgentRunner } from "./agent.js";
import { agentOptions, claudeTokens, type Config } from "./config.js";

export interface TokenPoolOptions {
  /** How long a token rests after hitting its usage limit. */
  limitCooldownMs?: number;
  /** How long a token is benched after being rejected (expired, revoked, mistyped). */
  rejectedCooldownMs?: number;
  now?: () => number;
  log?: (fields: Record<string, unknown>) => void;
}

/**
 * An agent runner that rotates across `tokens`. Only the usage-limit / auth
 * failure moves a request to the next token; any other failure is returned
 * as is. Tokens are only ever logged by position (#1, #2…).
 */
export function tokenPoolRunner(
  tokens: string[],
  makeRunner: (token: string) => AgentRunner,
  options: TokenPoolOptions = {},
): AgentRunner {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const limitCooldown = options.limitCooldownMs ?? 60 * 60_000;
  const rejectedCooldown = options.rejectedCooldownMs ?? 24 * 60 * 60_000;
  const runners = tokens.map(makeRunner);
  const restingUntil = tokens.map(() => 0);
  let next = 0;

  /** The next token not resting, in turn order, or -1. */
  const pick = (exclude: Set<number>): number => {
    for (let k = 0; k < tokens.length; k++) {
      const i = (next + k) % tokens.length;
      if (!exclude.has(i) && restingUntil[i]! <= now()) return i;
    }
    return -1;
  };

  return {
    async run<T>(request: AgentRequest<T>): Promise<AgentResult<T>> {
      const tried = new Set<number>();
      let costUsd = 0;
      let last: AgentResult<T> | undefined;
      for (;;) {
        const i = pick(tried);
        if (i < 0) break;
        tried.add(i);
        next = (i + 1) % tokens.length;
        const result = await runners[i]!.run(request);
        costUsd += result.costUsd;
        if (result.ok || result.failure !== "auth_or_limit") return { ...result, costUsd };
        const status = Number(/API error (\d{3})/.exec(result.detail)?.[1] ?? 0);
        const rejected = status === 401 || status === 403;
        restingUntil[i] = now() + (rejected ? rejectedCooldown : limitCooldown);
        log({
          level: rejected ? "error" : "warn",
          msg: rejected ? "Claude token rejected; benched" : "Claude token at its usage limit; resting",
          token: `#${i + 1}`,
          until: new Date(restingUntil[i]!).toISOString(),
        });
        last = { ...result, costUsd };
      }
      if (last) return last;
      const soonest = Math.min(...restingUntil);
      return {
        ok: false,
        failure: "auth_or_limit",
        detail: `All ${tokens.length} Claude tokens are resting until ${new Date(soonest).toISOString()}.`,
        costUsd,
      };
    },
  };
}

/**
 * The agent runner for this configuration: one runner for zero or one
 * token (zero means Claude Code's own login or ANTHROPIC_API_KEY), or a pool.
 */
export function agentRunnerFor(config: Config, log?: (fields: Record<string, unknown>) => void): AgentRunner {
  const base = agentOptions(config);
  const tokens = claudeTokens(config);
  if (tokens.length <= 1) return sdkAgentRunner(tokens[0] ? { ...base, oauthToken: tokens[0] } : base);
  return tokenPoolRunner(tokens, (token) => sdkAgentRunner({ ...base, oauthToken: token }), {
    limitCooldownMs: config.CLAUDE_TOKEN_COOLDOWN_MIN * 60_000,
    ...(log ? { log } : {}),
  });
}
