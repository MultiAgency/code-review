import { createSign } from "node:crypto";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** GET every page of a list endpoint. */
  list<T>(path: string): Promise<T[]>;
}

export interface GitHubClientOptions {
  apiUrl: string;
  /** Called per request, so a long job always uses an unexpired token. */
  token: () => Promise<string>;
  authScheme?: "token" | "Bearer";
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retries?: number;
}

/**
 * GitHub REST with a per-call timeout and retries for the failures that pass:
 * network errors, 5xx, and rate limits (honouring Retry-After). Validation
 * errors (4xx) are not retried.
 */
export function githubClient(opts: GitHubClientOptions): GitHubClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep =
    opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retries = opts.retries ?? 3;

  async function call(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      let failure: unknown;
      try {
        response = await doFetch(url, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `${opts.authScheme ?? "token"} ${await opts.token()}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "multi-review",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 2 * 60_000),
        });
      } catch (error) {
        failure = error;
      }
      const rateLimited =
        response !== undefined &&
        (response.status === 429 ||
          (response.status === 403 &&
            response.headers.get("x-ratelimit-remaining") === "0"));
      const transient =
        failure !== undefined ||
        rateLimited ||
        (response !== undefined && response.status >= 500);
      if (!transient || attempt >= retries) {
        if (response) return response;
        throw failure;
      }
      const retryAfter = Number(response?.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 4 ** attempt,
      );
    }
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await call(method, `${opts.apiUrl}${path}`, body);
    if (!response.ok) {
      throw new GitHubError(
        response.status,
        `${method} ${path}: ${response.status} ${(await response.text()).slice(0, 500)}`,
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  return {
    request,
    async list<T>(path: string): Promise<T[]> {
      const items: T[] = [];
      let url: string | undefined =
        `${opts.apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
      while (url) {
        const response = await call("GET", url);
        if (!response.ok)
          throw new GitHubError(
            response.status,
            `GET ${path}: ${response.status}`,
          );
        items.push(...((await response.json()) as T[]));
        url = /<([^>]+)>;\s*rel="next"/.exec(
          response.headers.get("link") ?? "",
        )?.[1];
      }
      return items;
    },
  };
}

export interface GitHubAuth {
  apiUrl: string;
  appId?: string;
  appPrivateKey?: string;
  /** Fallback when not running as a GitHub App (fine-grained PAT). */
  token?: string;
}

/**
 * Tokens for a repo's installation, reused for up to 50 minutes (they last an
 * hour), or the PAT when not running as an app.
 */
export function installationToken(
  auth: GitHubAuth,
  installationId: number | undefined,
): () => Promise<string> {
  let cached: { token: string; at: number } | undefined;
  return async () => {
    if (auth.appId && auth.appPrivateKey && installationId !== undefined) {
      if (!cached || Date.now() - cached.at > 50 * 60_000) {
        const app = githubClient({
          apiUrl: auth.apiUrl,
          token: async () => appJwt(auth.appId!, auth.appPrivateKey!),
          authScheme: "Bearer",
        });
        const { token } = await app.request<{ token: string }>(
          "POST",
          `/app/installations/${installationId}/access_tokens`,
        );
        cached = { token, at: Date.now() };
      }
      return cached.token;
    }
    if (auth.token) return auth.token;
    throw new Error(
      "No GitHub credentials: set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN.",
    );
  };
}

function appJwt(appId: string, privateKey: string): string {
  const base64url = (input: string | Buffer) =>
    Buffer.from(input).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface PullRequest {
  number: number;
  state: string;
  title: string;
  body: string | null;
  head: { sha: string };
  base: { ref: string; sha: string; repo: { clone_url: string; private: boolean } };
  additions: number;
  deletions: number;
}

export function getPullRequest(
  gh: GitHubClient,
  repo: string,
  prNumber: number,
): Promise<PullRequest> {
  return gh.request<PullRequest>("GET", `/repos/${repo}/pulls/${prNumber}`);
}

/** How `head` relates to `base`, and their merge base (what GitHub diffs a PR against). */
export async function compareCommits(
  gh: GitHubClient,
  repo: string,
  base: string,
  head: string,
) {
  const c = await gh.request<{
    status: "ahead" | "behind" | "identical" | "diverged";
    merge_base_commit: { sha: string };
  }>("GET", `/repos/${repo}/compare/${base}...${head}`);
  return { status: c.status, mergeBase: c.merge_base_commit.sha };
}
