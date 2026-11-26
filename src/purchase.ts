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
  /** The last moment the gateway can collect the payment: a review delivered after it is not paid for. */
  deadline: z.iso.datetime().optional(),
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

/** Time a purchase's outcome needs to reach the gateway before its deadline. */
const DELIVERY_MARGIN_MS = 60_000;
/** Less time than this left for an attempt is not worth starting: a review takes a few minutes. */
const MIN_ATTEMPT_MS = 5 * 60_000;

/**
 * How long a purchase's next attempt may run: what is left before its deadline, less the time to deliver, capped at
 * `maxMs`. Undefined when too little is left to start one.
 */
export function attemptTime(deadline: number | undefined, now: number, maxMs: number): number | undefined {
  if (deadline === undefined) return maxMs;
  const left = deadline - now - DELIVERY_MARGIN_MS;
  return left < MIN_ATTEMPT_MS ? undefined : Math.min(left, maxMs);
}

/**
 * Asks the gateway whether a purchase's job is still running, before any money is spent on it. A refused or dropped
 * job is gone (404) and an ended one has a final status; either way nobody will collect the review. An unreachable
 * gateway is no proof the job is gone, so the purchase goes ahead and delivering its outcome will tell.
 */
export function purchaseWanted(
  callback: PurchaseRequest["callback"],
  send: typeof fetch = fetch,
): () => Promise<boolean> {
  const status = callback.url.replace(/\/outcome$/, "");
  return async () => {
    try {
      const res = await send(status, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return false;
      if (!res.ok) return true;
      const job = (await res.json()) as { status?: unknown };
      return job.status === "running";
    } catch {
      return true;
    }
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
