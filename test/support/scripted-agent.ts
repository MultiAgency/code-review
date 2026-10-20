import type { AgentRequest, AgentResult, AgentRunner } from "../../src/agent.ts";

/**
 * The test adapter for the agent runner: answers each pass from a script and
 * records the requests it saw.
 */
export function scriptedAgent(...script: Array<(request: AgentRequest<unknown>) => AgentResult<unknown>>) {
  const requests: AgentRequest<unknown>[] = [];
  const runner: AgentRunner = {
    async run<T>(request: AgentRequest<T>): Promise<AgentResult<T>> {
      requests.push(request as AgentRequest<unknown>);
      const step = script[requests.length - 1];
      if (!step) throw new Error(`unexpected agent pass #${requests.length}`);
      return step(request as AgentRequest<unknown>) as AgentResult<T>;
    },
  };
  return { runner, requests };
}

export const ok = <T>(data: T, costUsd = 0.1): AgentResult<T> => ({ ok: true, data, costUsd });
