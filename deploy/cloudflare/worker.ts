// Runs the reviewer service (the repo's Docker image) as a Cloudflare Container, one instance.
// The Worker only forwards GitHub's webhook and the health check to it; the service does the rest.
//
// A container stops once its Durable Object has been inactive for the inactivity timeout, and its
// disk is ephemeral. Reviews keep running after the webhook is answered, so an alarm checks the
// service's queue while it is busy and keeps the container up until nothing is running or queued.
//
// The container gets its settings and secrets when it starts, and a deploy that keeps the image
// doesn't restart it. So the settings it started with are remembered, and once they are out of date
// the container is restarted the next time it is idle; a review in progress is never cut off.
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
    try {
      return await env.REVIEWER.get(env.REVIEWER.idFromName("main")).fetch(request);
    } catch (error) {
      // The health check says why the service is unavailable; webhooks just get a 503.
      const detail = pathname === "/healthz" ? { error: String(error) } : {};
      return Response.json({ ok: false, ...detail }, { status: 503 });
    }
  },
};

export class Reviewer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  async fetch(request: Request): Promise<Response> {
    if (this.container().running && (await this.outdated()) && (await this.idle()) === true)
      await this.stop();
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

  /**
   * Keeps the container alive while the service has reviews running or queued
   * (or can't say), and restarts it on new settings once it is idle.
   */
  async alarm(): Promise<void> {
    if (!this.container().running) return;
    const idle = await this.idle();
    if (idle === true) {
      if (await this.outdated()) await this.stop();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + BUSY_CHECK_MS);
  }

  private container() {
    return this.ctx.container!;
  }

  /** The settings and secrets the container is given: every string binding. */
  private containerEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.env)) if (typeof value === "string") env[name] = value;
    return env;
  }

  /** A hash of the container's settings, so a change can be noticed without storing secrets. */
  private async settingsVersion(): Promise<string> {
    const env = this.containerEnv();
    const text = JSON.stringify(Object.keys(env).sort().map((k) => [k, env[k]]));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async outdated(): Promise<boolean> {
    return (await this.ctx.storage.get<string>("settings")) !== (await this.settingsVersion());
  }

  /** True when nothing is running or queued; undefined when the service doesn't answer. */
  private async idle(): Promise<boolean | undefined> {
    try {
      const res = await this.container().getTcpPort(PORT).fetch("http://container/healthz", {
        signal: AbortSignal.timeout(5_000),
      });
      const stats = (await res.json()) as { running?: number; queued?: number };
      return (stats.running ?? 0) + (stats.queued ?? 0) === 0;
    } catch {
      return undefined;
    }
  }

  private async stop(): Promise<void> {
    const container = this.container();
    const exited = container.monitor().catch(() => {});
    await container.destroy("settings changed");
    await Promise.race([exited, scheduler.wait(10_000)]);
  }

  private async startAndWaitForPort(): Promise<void> {
    const container = this.container();
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: INSTANCE,
        enableInternet: true,
        env: this.containerEnv(),
      });
      await this.ctx.storage.put("settings", await this.settingsVersion());
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
