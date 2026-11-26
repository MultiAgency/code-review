import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { PurchaseRequest, type Refusal } from "./purchase.js";
import type { ReviewQueue } from "./queue.js";
import { jobFromWebhook } from "./triggers.js";

export interface WebhookOptions {
  secret: string;
  trigger: string;
  allowedRepos: string[];
  queue: Pick<ReviewQueue, "submit" | "stats">;
  /** Present when purchased reviews are on. */
  purchases?: PurchaseOptions;
  log?: (fields: Record<string, unknown>) => void;
}

export interface PurchaseOptions {
  /** The bearer token the gateway presents. */
  token: string;
  /** The gateway's base URL; a purchase's callback must be under it. */
  gateway: string;
  /** Why this PR can't be sold a review, or undefined when it can. */
  admit(repo: string, prNumber: number): Promise<Refusal | undefined>;
}

/**
 * The HTTP adapter: verifies GitHub's signature, turns review-worthy events
 * into review jobs, takes purchased reviews from the gateway, and serves a
 * health check. Never does review work itself.
 */
export function webhookHandler(options: WebhookOptions): RequestListener {
  const log = options.log ?? (() => {});
  return (req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/healthz") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ok: true, ...options.queue.stats() }));
        return;
      }
      if (req.method === "POST" && req.url === "/jobs" && options.purchases) {
        await purchase(req, res, options.purchases);
        return;
      }
      if (req.method !== "POST" || req.url !== "/webhook") {
        res.writeHead(404).end();
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413).end();
        return;
      }
      if (
        !validSignature(
          options.secret,
          body,
          req.headers["x-hub-signature-256"],
        )
      ) {
        res.writeHead(401).end("bad signature");
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const decision = jobFromWebhook(
        String(req.headers["x-github-event"] ?? ""),
        payload,
        {
          trigger: options.trigger,
          allowedRepos: options.allowedRepos,
        },
      );
      if ("skip" in decision) {
        res.writeHead(204).end();
        return;
      }
      const { job } = decision;
      const delivery = String(
        req.headers["x-github-delivery"] ??
          `${job.repo}#${job.prNumber}:${Date.now()}`,
      );
      const result = options.queue.submit(job, delivery);
      log({
        pr: `${job.repo}#${job.prNumber}`,
        msg: result,
        reason: job.reason,
        requestedBy: job.requestedBy,
        delivery,
      });
      res.writeHead(202).end(result);
    })().catch((error) => {
      log({
        level: "error",
        msg: "webhook handler failed",
        error: String(error),
      });
      if (!res.headersSent) res.writeHead(500).end();
    });
  };

  /**
   * A purchased review, from the gateway: 202 once it is queued. A PR that
   * can't be reviewed is refused with 422 and the reason, before the buyer pays.
   */
  async function purchase(req: IncomingMessage, res: ServerResponse, purchases: PurchaseOptions) {
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (!sameText(req.headers.authorization ?? "", `Bearer ${purchases.token}`)) {
      res.writeHead(401).end();
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const request = PurchaseRequest.safeParse(payload);
    if (!request.success || !under(request.data.callback.url, purchases.gateway)) {
      json(400, { error: "invalid_request", message: "Not a purchase this service accepts." });
      return;
    }
    const { id, input, callback } = request.data;
    const refusal = await purchases.admit(input.repo, input.pr);
    if (refusal) {
      log({ pr: `${input.repo}#${input.pr}`, msg: "purchase refused", reason: refusal.error, purchase: id });
      json(422, refusal);
      return;
    }
    const result = options.queue.submit(
      { repo: input.repo, prNumber: input.pr, reason: "purchase", purchase: { id, callback } },
      `purchase ${id}`,
    );
    log({ pr: `${input.repo}#${input.pr}`, msg: result, reason: "purchase", purchase: id });
    res.writeHead(202).end(result);
  }
}

/** Whether `url` is the gateway's own address or a path beneath it. */
function under(url: string, gateway: string): boolean {
  const base = gateway.endsWith("/") ? gateway : `${gateway}/`;
  return url.startsWith(base);
}

/** Compares two strings without revealing where they differ. */
function sameText(a: string, b: string): boolean {
  const digest = (text: string) => createHmac("sha256", "compare").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function readBody(
  req: IncomingMessage,
  limit = 25 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validSignature(
  secret: string,
  body: Buffer,
  header: string | string[] | undefined,
): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
