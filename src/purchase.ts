// Purchased reviews: a gateway that has taken payment asks for a review of a public PR, and the
// outcome is delivered to the gateway's callback. Nothing is posted on GitHub.
import { z } from "zod";
import { getPullRequest, GitHubError, type GitHubClient } from "./github.js";
import type { Publisher } from "./publisher.js";
import { failureText, type FailureReason, type ReportData } from "./report.js";
import { isSkipped } from "./workspace.js";

export const PurchaseRequest = z.object({
  id: z.uuid(),
  input: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    pr: z.number().int().positive(),
  }),
  callback: z.object({ url: z.url(), token: z.string().min(1) }),
});
export type PurchaseRequest = z.infer<typeof PurchaseRequest>;

/** Why a purchase is turned away before any work. The gateway passes it to the buyer, uncharged. */
export interface Refusal {
  error: "not_found" | "not_open" | "private" | "too_large" | "nothing_to_review";
  message: string;
}

/**
 * Decides whether a PR can be sold a review, before the buyer is charged: it
 * must be public, open, small enough to review within a purchase's budget, and
 * change at least one file a review reads.
 */
export function purchaseAdmission(
  gh: GitHubClient,
  maxChangedLines: number,
): (repo: string, prNumber: number) => Promise<Refusal | undefined> {
  return async (repo, prNumber) => {
    let pr;
    try {
      pr = await getPullRequest(gh, repo, prNumber);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404)
        return { error: "not_found", message: "No such pull request in a public repository." };
      throw error;
    }
    if (pr.base.repo.private)
      return { error: "private", message: "Only pull requests in public repositories can be reviewed." };
    if (pr.state !== "open")
      return { error: "not_open", message: "The pull request is not open." };
    if (pr.additions + pr.deletions > maxChangedLines)
      return {
        error: "too_large",
        message: `The pull request changes more than ${maxChangedLines} lines, which is too large to review.`,
      };
    const files = await gh.list<{ filename: string }>(`/repos/${repo}/pulls/${prNumber}/files`);
    if (files.every((file) => isSkipped(file.filename)))
      return {
        error: "nothing_to_review",
        message: "The pull request changes only lockfiles, build output or vendored code, which a review leaves out.",
      };
    return undefined;
  };
}

export type PurchaseOutcome =
  | { status: "done"; result: ReportData }
  | { status: "failed"; reason: FailureReason | "not_open"; message: string };

export type Deliver = (outcome: PurchaseOutcome) => Promise<void>;

/** Posts a purchase's outcome to its callback; throws when the gateway doesn't accept it. */
export function callbackDelivery(
  callback: PurchaseRequest["callback"],
  send: typeof fetch = fetch,
): Deliver {
  return async (outcome) => {
    const res = await send(callback.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${callback.token}`,
      },
      body: JSON.stringify(outcome),
      signal: AbortSignal.timeout(30_000),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`purchase callback answered ${res.status}`);
  };
}

/**
 * The purchase adapter: delivers a finished review as data. A failed attempt is
 * not reported here, because the job may still be retried; `failedOutcome`
 * is delivered once the job has ended.
 */
export function purchasePublisher(deliver: Deliver): Publisher {
  return {
    async started() {},
    async prior() {
      return undefined;
    },
    async publish(report) {
      await deliver({ status: "done", result: report.renderData() });
    },
    async failed() {},
    async waiting() {},
  };
}

export function failedOutcome(reason: FailureReason | "not_open"): PurchaseOutcome {
  return {
    status: "failed",
    reason,
    message: reason === "not_open" ? "The pull request is no longer open." : failureText(reason),
  };
}
