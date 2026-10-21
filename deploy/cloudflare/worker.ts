// Runs the reviewer service (the repo's Docker image) as a Cloudflare Container, one instance.
// The Worker only forwards GitHub's webhook and the health check to it; the service does the rest.
//
// A container stops once its Durable Object has been inactive for the inactivity timeout, and its
// disk is ephemeral. Reviews keep running after the webhook is answered, so an alarm checks the
// service's queue while it is busy and keeps the container up until nothing is running or queued.
import { DurableObject } from "cloudflare:workers";

interface Env {
  REVIEWER: DurableObjectNamespace<Reviewer>;
  /** Secrets and settings for the service; every string binding is passed to the container. */
  [name: string]: unknown;
}

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 10 * 60_000;
/** Shorter than the inactivity timeout, so a busy container is never stopped between checks. */
const BUSY_CHECK_MS = 4 * 60_000;
const INSTANCE = "standard-1"; // 1/2 vCPU, 4 GiB: two Claude Code processes plus git

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const allowed =
      (request.method === "POST" && pathname === "/webhook") ||
      (request.method === "GET" && pathname === "/healthz");
    if (!allowed) return new Response("Not found", { status: 404 });
    return env.REVIEWER.get(env.REVIEWER.idFromName("main")).fetch(request);
  },
};

export class Reviewer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  async fetch(request: Request): Promise<Response> {
    this.starting ??= this.startAndWaitForPort().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    await this.ctx.storage.setAlarm(Date.now() + BUSY_CHECK_MS);

    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.container().getTcpPort(PORT).fetch(forwarded);
  }

  /** Keeps the container alive while the service has reviews running or queued. */
  async alarm(): Promise<void> {
    const container = this.container();
    if (!container.running) return;
    try {
      const res = await container.getTcpPort(PORT).fetch("http://container/healthz", {
        signal: AbortSignal.timeout(5_000),
      });
      const stats = (await res.json()) as { running?: number; queued?: number };
      if ((stats.running ?? 0) + (stats.queued ?? 0) > 0)
        await this.ctx.storage.setAlarm(Date.now() + BUSY_CHECK_MS);
    } catch {
      // Unhealthy or restarting: check again rather than let a review be cut off.
      await this.ctx.storage.setAlarm(Date.now() + BUSY_CHECK_MS);
    }
  }

  private container() {
    return this.ctx.container!;
  }

  private async startAndWaitForPort(): Promise<void> {
    const container = this.container();
    if (!container.running) {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(this.env))
        if (typeof value === "string") env[name] = value;
      container.start({
        image: container.images.base,
        instance: INSTANCE,
        enableInternet: true,
        env,
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    const port = container.getTcpPort(PORT);
    let lastError: unknown;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const res = await port.fetch("http://container/healthz", { signal: AbortSignal.timeout(1_000) });
        await res.body?.cancel();
        if (res.ok) return;
        lastError = new Error(`health check returned ${res.status}`);
      } catch (error) {
        lastError = error;
      }
      await scheduler.wait(200);
    }
    throw new Error(`The reviewer didn't start: ${String(lastError)}`);
  }
}
