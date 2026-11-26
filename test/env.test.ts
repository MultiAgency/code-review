import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeEnv, gitEnv } from "../src/env.ts";

function withEnv(vars: Record<string, string>, fn: () => void) {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("Claude never sees GitHub credentials; cloud credentials only for its own provider", () => {
  withEnv(
    {
      GITHUB_TOKEN: "ghp_x",
      GITHUB_WEBHOOK_SECRET: "w",
      GITHUB_APP_PRIVATE_KEY: "k",
      AWS_SECRET_ACCESS_KEY: "aws",
      CLAUDE_CODE_OAUTH_TOKEN: "oat",
      https_proxy: "http://p",
    },
    () => {
      const env = claudeEnv();
      for (const key of [
        "GITHUB_TOKEN",
        "GITHUB_WEBHOOK_SECRET",
        "GITHUB_APP_PRIVATE_KEY",
        "AWS_SECRET_ACCESS_KEY",
      ]) {
        assert.equal(env[key], undefined, key);
      }
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oat");
      assert.equal(env.https_proxy, "http://p");
    },
  );
  withEnv(
    { CLAUDE_CODE_USE_BEDROCK: "1", AWS_SECRET_ACCESS_KEY: "aws" },
    () => {
      assert.equal(claudeEnv().AWS_SECRET_ACCESS_KEY, "aws");
    },
  );
});

test("git sees neither model nor GitHub credentials, nor host config", () => {
  withEnv(
    {
      CLAUDE_CODE_OAUTH_TOKEN: "oat",
      GITHUB_TOKEN: "ghp_x",
      ANTHROPIC_API_KEY: "sk",
    },
    () => {
      const env = gitEnv({ GIT_CONFIG_COUNT: "1" });
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(env.GIT_CONFIG_COUNT, "1");
    },
  );
});

test("a token list never reaches Claude, and each token in it is redacted", async () => {
  const { redactSecrets } = await import("../src/env.ts");
  withEnv({ CLAUDE_CODE_OAUTH_TOKENS: "sk-ant-oat-first-123456,sk-ant-oat-second-654321" }, () => {
    assert.equal(claudeEnv().CLAUDE_CODE_OAUTH_TOKENS, undefined);
    assert.equal(claudeEnv({ oauthToken: "sk-ant-oat-second-654321" }).CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-second-654321");
    const out = redactSecrets("leaked sk-ant-oat-second-654321 and sk-ant-oat-first-123456");
    assert.doesNotMatch(out, /sk-ant-oat/);
  });
});

test("an API key replaces the subscription token, so the process bills the key", () => {
  withEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oat", ANTHROPIC_API_KEY: "sk-ant-api-own" }, () => {
    const env = claudeEnv({ apiKey: "sk-ant-api-purchases" });
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-api-purchases");
    assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in env, false);
    assert.equal("ANTHROPIC_BASE_URL" in env, false);
    const viaGateway = claudeEnv({ apiKey: "gateway-key", baseUrl: "https://cloud-api.near.ai" });
    assert.deepEqual([viaGateway.ANTHROPIC_API_KEY, viaGateway.ANTHROPIC_BASE_URL], ["gateway-key", "https://cloud-api.near.ai"]);
  });
});
