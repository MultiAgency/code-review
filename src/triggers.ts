export interface ReviewJob {
  repo: string;
  prNumber: number;
  installationId?: number;
  reason: "opened" | "ready_for_review" | "comment";
  /** The triggering comment, for comment-requested reviews. */
  commentId?: number;
  /** `@private-review full`: review the whole PR, not just new commits. */
  full?: boolean;
  requestedBy?: string;
}

export type TriggerDecision = { job: ReviewJob } | { skip: string };

// PR authors who get automatic reviews and commenters who can request one.
// Public-repo outsiders (CONTRIBUTOR, NONE, ...) can't spend the review budget.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** True when a line of the comment is the trigger, optionally followed by more text. */
export function mentionsTrigger(body: string, trigger: string): boolean {
  return triggerLine(body, trigger) !== undefined;
}

/** The text after the trigger on its line ("" for a bare trigger). */
function triggerLine(body: string, trigger: string): string | undefined {
  const t = trigger.trim().toLowerCase();
  for (const line of body.split("\n")) {
    const l = line.trim().toLowerCase();
    if (l === t) return "";
    if (l.startsWith(`${t} `)) return l.slice(t.length).trim();
  }
  return undefined;
}

/**
 * Reviews run once automatically, when a trusted author's PR first becomes
 * reviewable (opened as non-draft, or marked ready), and again whenever a
 * trusted member comments the trigger phrase. Pushes don't trigger reviews.
 */
export function jobFromWebhook(
  event: string,
  payload: any,
  opts: { trigger: string; allowedRepos: string[] },
): TriggerDecision {
  const repo: string | undefined = payload?.repository?.full_name;
  if (!repo) return { skip: "no repository" };
  if (
    opts.allowedRepos.length > 0 &&
    !opts.allowedRepos.includes(repo.toLowerCase())
  ) {
    return { skip: "repo not allowed" };
  }
  const installationId: number | undefined = payload.installation?.id;

  if (event === "pull_request") {
    const pr = payload.pull_request;
    if (!pr) return { skip: "no pull_request in payload" };
    const reviewable =
      (payload.action === "opened" && !pr.draft) ||
      payload.action === "ready_for_review";
    if (!reviewable)
      return {
        skip: `pull_request.${payload.action}${pr.draft ? " (draft)" : ""}`,
      };
    // Automatic reviews spend the review budget, so only trusted authors get
    // them. Anyone else's PR is reviewed when a trusted member asks.
    if (pr.user?.type === "Bot")
      return { skip: `author ${pr.user.login} is a bot` };
    if (!TRUSTED_ASSOCIATIONS.has(pr.author_association)) {
      return { skip: `author ${pr.user?.login} is ${pr.author_association}` };
    }
    return {
      job: {
        repo,
        prNumber: pr.number,
        installationId,
        reason: payload.action,
      },
    };
  }

  if (event === "issue_comment") {
    const { issue, comment, sender } = payload;
    if (payload.action !== "created")
      return { skip: `issue_comment.${payload.action}` };
    if (!issue?.pull_request)
      return { skip: "comment is on an issue, not a PR" };
    if (issue.state !== "open") return { skip: "PR is closed" };
    if (sender?.type === "Bot") return { skip: "comment from a bot" };
    const rest = triggerLine(comment?.body ?? "", opts.trigger);
    if (rest === undefined) return { skip: "no trigger phrase" };
    if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
      return {
        skip: `commenter ${sender?.login} is ${comment.author_association}`,
      };
    }
    return {
      job: {
        repo,
        prNumber: issue.number,
        installationId,
        reason: "comment",
        commentId: comment.id,
        requestedBy: sender?.login,
        ...(rest.split(/\s+/)[0] === "full" ? { full: true } : {}),
      },
    };
  }

  return { skip: `event ${event}` };
}
