// One place for what each subprocess may see, and what must never be published.

const BASE = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"];
const NETWORK = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
];

function pick(names: (key: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && names(key)) out[key] = value;
  }
  return out;
}

/**
 * The Claude Code process: its own auth and settings, plus cloud credentials
 * only when that cloud is the model provider. GitHub credentials and the
 * webhook secret are never passed, so a prompt-injected PR can't read them.
 */
export function claudeEnv(oauthToken?: string): Record<string, string> {
  const bedrock = process.env.CLAUDE_CODE_USE_BEDROCK === "1";
  const vertex = process.env.CLAUDE_CODE_USE_VERTEX === "1";
  return {
    ...pick(
      (key) =>
        BASE.includes(key) ||
        NETWORK.includes(key) ||
        key.startsWith("ANTHROPIC_") ||
        // The token list stays out: each process gets only the one token it uses.
        (key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CODE_OAUTH_TOKENS") ||
        (bedrock && key.startsWith("AWS_")) ||
        (vertex &&
          (key.startsWith("CLOUD_ML_") ||
            key.startsWith("GOOGLE_") ||
            key.startsWith("VERTEX_"))),
    ),
    ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    CLAUDE_AGENT_SDK_CLIENT_APP: "multi-review/0.2.0",
  };
}

/** git: no model or GitHub credentials (fetch auth is passed per call, via GIT_CONFIG_*). */
export function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...pick((key) => BASE.includes(key) || NETWORK.includes(key)),
    ...extra,
    GIT_TERMINAL_PROMPT: "0",
    // The host's global and system config can't change what the reviewer sees or runs.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

/**
 * Git auth via an extra header in env-provided config, so the token never
 * appears in argv, the remote URL, or .git/config.
 */
export function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

const SECRET_NAMES = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** Masks any secret env value that ends up in text we are about to publish. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !SECRET_NAMES.test(key)) continue;
    // A list (e.g. several tokens) is redacted whole and item by item.
    for (const secret of [value, ...value.split(/[\s,]+/)]) {
      if (secret.length >= 12) out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}
