export interface ReviewJob {
  repo: string;
  prNumber: number;
  installationId?: number;
  reason: "opened" | "ready_for_review" | "comment";
  /** The triggering comment, for comment-requested reviews. */
  commentId?: number;
  requestedBy?: string;
}

export type TriggerDecision = { job: ReviewJob } | { skip: string };

// Commenters who can request a review. Public-repo outsiders (CONTRIBUTOR,
// NONE, ...) can't, so they can't spend the review budget.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** True when a line of the comment is the trigger, optionally followed by more text. */
export function mentionsTrigger(body: string, trigger: string): boolean {
  const t = trigger.trim().toLowerCase();
  return body.split("\n").some((line) => {
    const l = line.trim().toLowerCase();
    return l === t || l.startsWith(`${t} `);
  });
}

/**
 * Reviews run once automatically, when a PR first becomes reviewable (opened
 * as non-draft, or marked ready), and again whenever someone with access
 * comments the trigger phrase. Pushes don't trigger reviews.
 */
export function jobFromWebhook(event: string, payload: any, opts: { trigger: string; allowedRepos: string[] }): TriggerDecision {
  const repo: string | undefined = payload?.repository?.full_name;
  if (!repo) return { skip: "no repository" };
  if (opts.allowedRepos.length > 0 && !opts.allowedRepos.includes(repo.toLowerCase())) {
    return { skip: "repo not allowed" };
  }
  const installationId: number | undefined = payload.installation?.id;

  if (event === "pull_request") {
    const pr = payload.pull_request;
    if (payload.action === "opened" && !pr.draft) {
      return { job: { repo, prNumber: pr.number, installationId, reason: "opened" } };
    }
    if (payload.action === "ready_for_review") {
      return { job: { repo, prNumber: pr.number, installationId, reason: "ready_for_review" } };
    }
    return { skip: `pull_request.${payload.action}${pr?.draft ? " (draft)" : ""}` };
  }

  if (event === "issue_comment") {
    const { issue, comment, sender } = payload;
    if (payload.action !== "created") return { skip: `issue_comment.${payload.action}` };
    if (!issue?.pull_request) return { skip: "comment is on an issue, not a PR" };
    if (issue.state !== "open") return { skip: "PR is closed" };
    if (sender?.type === "Bot") return { skip: "comment from a bot" };
    if (!mentionsTrigger(comment?.body ?? "", opts.trigger)) return { skip: "no trigger phrase" };
    if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
      return { skip: `commenter ${sender?.login} is ${comment.author_association}` };
    }
    return {
      job: {
        repo,
        prNumber: issue.number,
        installationId,
        reason: "comment",
        commentId: comment.id,
        requestedBy: sender?.login,
      },
    };
  }

  return { skip: `event ${event}` };
}
