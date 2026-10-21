import {
  compareCommits,
  getPullRequest,
  GitHubError,
  type GitHubClient,
} from "./github.js";
import {
  parseState,
  renderFailure,
  renderWaiting,
  SUMMARY_MARKER,
  type FailureReason,
  type PlannedComment,
  type ReviewReport,
  type ReviewState,
} from "./report.js";

/** Delivers a review's progress and results somewhere. */
export interface Publisher {
  /** The review has started (👀). */
  started(): Promise<void>;
  /** State remembered from the last review of this PR, if any. */
  prior(): Promise<ReviewState | undefined>;
  publish(report: ReviewReport): Promise<void>;
  failed(reason: FailureReason, prior?: ReviewState): Promise<void>;
  /** The review will run again at `until` (epoch ms), after Claude's usage limit resets. */
  waiting(until: number, prior?: ReviewState): Promise<void>;
}

/** The dry-run adapter: writes what would be posted to a log. */
export function logPublisher(
  log: (fields: Record<string, unknown>) => void,
): Publisher {
  return {
    async started() {},
    async prior() {
      return undefined;
    },
    async publish(report) {
      log({
        msg: "would post",
        inlineComments: report.inline.length,
        fileComments: report.fileComments.length,
        review: report.renderText(),
      });
    },
    async failed(reason) {
      log({ msg: "would report failure", reason });
    },
    async waiting(until) {
      log({ msg: "would report waiting", until: new Date(until).toISOString() });
    },
  };
}

export interface IssueComment {
  id: number;
  body?: string;
  user?: { login: string; type: string };
  performed_via_github_app?: { id: number } | null;
}

/**
 * Posts to a PR: one summary comment edited in place, a COMMENT review with
 * inline comments for new findings, file-level comments, and status reactions
 * on the trigger comment (or the PR). Needs Pull requests: write and Issues: write.
 */
export function githubPublisher(opts: {
  gh: GitHubClient;
  repo: string;
  prNumber: number;
  /** The comment that asked for the review; reactions go on the PR otherwise. */
  triggerCommentId?: number;
  /**
   * Whether a comment was written by this service. Anyone can post a comment
   * that starts with our marker, so the summary (and the state it carries) is
   * only trusted from our own comments.
   */
  isOwnComment: (comment: IssueComment) => boolean;
  /** The configured trigger phrase, which a failure summary invites people to retry with. */
  trigger: string;
  log?: (fields: Record<string, unknown>) => void;
}): Publisher {
  const { gh, repo, prNumber } = opts;
  const log = opts.log ?? (() => {});
  let summary: IssueComment | null | undefined;

  async function findSummary(): Promise<IssueComment | null> {
    if (summary === undefined) {
      const comments = await gh.list<IssueComment>(
        `/repos/${repo}/issues/${prNumber}/comments`,
      );
      summary =
        comments.find(
          (c) => c.body?.startsWith(SUMMARY_MARKER) && opts.isOwnComment(c),
        ) ?? null;
    }
    return summary;
  }

  async function upsertSummary(body: string) {
    const existing = await findSummary();
    summary = existing
      ? await gh.request<IssueComment>(
          "PATCH",
          `/repos/${repo}/issues/comments/${existing.id}`,
          { body },
        )
      : await gh.request<IssueComment>(
          "POST",
          `/repos/${repo}/issues/${prNumber}/comments`,
          { body },
        );
  }

  async function react(content: "eyes" | "hooray" | "confused") {
    const path =
      opts.triggerCommentId !== undefined
        ? `/repos/${repo}/issues/comments/${opts.triggerCommentId}/reactions`
        : `/repos/${repo}/issues/${prNumber}/reactions`;
    // Best effort: a missing Issues permission must not fail the review.
    await gh
      .request("POST", path, { content })
      .catch((error) => log({ msg: "reaction failed", error: String(error) }));
  }

  /** Comments may only go on the reviewed commit while the PR still contains it. */
  async function headStillInPr(reviewed: string): Promise<boolean> {
    const current = (await getPullRequest(gh, repo, prNumber)).head.sha;
    if (current === reviewed) return true;
    try {
      const { status } = await compareCommits(gh, repo, reviewed, current);
      return status === "ahead" || status === "identical";
    } catch {
      return false;
    }
  }

  return {
    started: () => react("eyes"),
    async prior() {
      const comment = await findSummary();
      return comment?.body ? parseState(comment.body) : undefined;
    },
    async publish(report) {
      const posted = new Set<string>();
      const planned = report.inline.length + report.fileComments.length;
      if (planned > 0 && (await headStillInPr(report.headSha))) {
        if (report.inline.length > 0) {
          try {
            await gh.request(
              "POST",
              `/repos/${repo}/pulls/${prNumber}/reviews`,
              {
                commit_id: report.headSha,
                event: "COMMENT",
                body: report.reviewBody,
                comments: report.inline.map(toReviewComment),
              },
            );
            for (const c of report.inline) posted.add(c.fp);
          } catch (error) {
            // GitHub rejected a position; those findings go in the summary instead.
            if (!(error instanceof GitHubError && error.status === 422))
              throw error;
            log({
              msg: "inline comments rejected, folding into summary",
              error: error.message,
            });
          }
        }
        for (const c of report.fileComments) {
          try {
            await gh.request(
              "POST",
              `/repos/${repo}/pulls/${prNumber}/comments`,
              {
                commit_id: report.headSha,
                path: c.path,
                body: c.body,
                subject_type: "file",
              },
            );
            posted.add(c.fp);
          } catch (error) {
            if (!(error instanceof GitHubError && error.status === 422))
              throw error;
          }
        }
      } else if (planned > 0) {
        log({
          msg: "PR head moved past the reviewed commit; findings go in the summary only",
        });
      }
      await upsertSummary(report.renderSummary(posted));
      await react("hooray");
    },
    async failed(reason, prior) {
      await upsertSummary(renderFailure(reason, { trigger: opts.trigger, prior }));
      await react("confused");
    },
    async waiting(until, prior) {
      await upsertSummary(renderWaiting(until, prior));
    },
  };
}

function toReviewComment(c: PlannedComment) {
  return {
    path: c.path,
    line: c.line,
    side: "RIGHT",
    ...(c.startLine !== undefined
      ? { start_line: c.startLine, start_side: "RIGHT" }
      : {}),
    body: c.body,
  };
}
