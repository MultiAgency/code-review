import { GitHubError, type GitHubClient } from "../../src/github.ts";
import type { IssueComment } from "../../src/publisher.ts";

/**
 * The test adapter for GitHub: an in-memory PR with issue comments, reviews,
 * review comments and reactions. Unknown calls fail loudly.
 */
export function fakeGitHub(opts: {
  head: string;
  base?: string;
  cloneUrl?: string;
  prState?: string;
  rejectInline?: boolean;
  compare?: Record<string, string>;
}) {
  const state = {
    head: opts.head,
    comments: [] as IssueComment[],
    reviews: [] as Array<{ commit_id: string; comments: unknown[] }>,
    fileComments: [] as unknown[],
    reactions: [] as Array<{ path: string; content: string }>,
    nextId: 1,
  };
  const gh: GitHubClient = {
    async request<T>(method: string, path: string, body?: any): Promise<T> {
      const route = `${method} ${path.replace(/^\/repos\/[^/]+\/[^/]+/, "")}`;
      let m: RegExpExecArray | null;
      if (route === "GET /pulls/1") {
        return {
          number: 1,
          state: opts.prState ?? "open",
          title: "t",
          body: "d",
          head: { sha: state.head },
          base: {
            ref: "main",
            sha: opts.base ?? "base",
            repo: { clone_url: opts.cloneUrl ?? "file:///unused" },
          },
        } as T;
      }
      if ((m = /^GET \/compare\/(\w+)\.\.\.(\w+)$/.exec(route))) {
        const status = opts.compare?.[`${m[1]}...${m[2]}`] ?? "ahead";
        return { status, merge_base_commit: { sha: m[1] } } as T;
      }
      if (route === "POST /issues/1/comments") {
        const c = {
          id: state.nextId++,
          body: body.body,
          performed_via_github_app: { id: 42 },
        };
        state.comments.push(c);
        return c as T;
      }
      if ((m = /^PATCH \/issues\/comments\/(\d+)$/.exec(route))) {
        const c = state.comments.find((x) => x.id === Number(m![1]))!;
        c.body = body.body;
        return c as T;
      }
      if (route === "POST /pulls/1/reviews") {
        if (opts.rejectInline)
          throw new GitHubError(
            422,
            "Unprocessable: line must be part of the diff",
          );
        state.reviews.push(body);
        return {} as T;
      }
      if (route === "POST /pulls/1/comments") {
        state.fileComments.push(body);
        return {} as T;
      }
      if (/reactions$/.test(route)) {
        state.reactions.push({ path, content: body.content });
        return {} as T;
      }
      throw new Error(`fake GitHub: unexpected ${method} ${path}`);
    },
    async list<T>(path: string): Promise<T[]> {
      if (/\/issues\/1\/comments$/.test(path)) return state.comments as T[];
      throw new Error(`fake GitHub: unexpected list ${path}`);
    },
  };
  return { gh, state };
}
