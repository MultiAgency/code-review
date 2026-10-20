import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener } from "node:http";
import type { ReviewQueue } from "./queue.js";
import { jobFromWebhook } from "./triggers.js";

export interface WebhookOptions {
  secret: string;
  trigger: string;
  allowedRepos: string[];
  queue: Pick<ReviewQueue, "submit" | "stats">;
  log?: (fields: Record<string, unknown>) => void;
}

/**
 * The HTTP adapter: verifies GitHub's signature, turns review-worthy events
 * into review jobs, and serves a health check. Never does review work itself.
 */
export function webhookHandler(options: WebhookOptions): RequestListener {
  const log = options.log ?? (() => {});
  return (req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...options.queue.stats() }));
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
      if (!validSignature(options.secret, body, req.headers["x-hub-signature-256"])) {
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
      const decision = jobFromWebhook(String(req.headers["x-github-event"] ?? ""), payload, {
        trigger: options.trigger,
        allowedRepos: options.allowedRepos,
      });
      if ("skip" in decision) {
        res.writeHead(204).end();
        return;
      }
      const { job } = decision;
      const delivery = String(req.headers["x-github-delivery"] ?? `${job.repo}#${job.prNumber}:${Date.now()}`);
      const result = options.queue.submit(job, delivery);
      log({ pr: `${job.repo}#${job.prNumber}`, msg: result, reason: job.reason, requestedBy: job.requestedBy, delivery });
      res.writeHead(202).end(result);
    })().catch((error) => {
      log({ level: "error", msg: "webhook handler failed", error: String(error) });
      if (!res.headersSent) res.writeHead(500).end();
    });
  };
}

function readBody(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> {
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

function validSignature(secret: string, body: Buffer, header: string | string[] | undefined): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
