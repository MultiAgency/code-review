import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkServiceConfig,
  ConfigError,
  loadConfig,
  reviewOptions,
} from "../src/config.ts";

test("defaults when nothing is set", () => {
  const c = loadConfig({});
  assert.equal(c.REVIEW_EFFORT, "high");
  assert.equal(c.MAX_CONCURRENT_REVIEWS, 2);
  assert.equal(c.POST_REVIEWS, false);
  assert.equal(c.REVIEW_MODEL, undefined);
  assert.equal(c.REVIEW_TRIGGER, "@private-review");
  assert.deepEqual(c.ALLOWED_REPOS, []);
});

test("bad values fail fast, all listed at once", () => {
  assert.throws(
    () =>
      loadConfig({
        MAX_CONCURRENT_REVIEWS: "abc",
        REVIEW_EFFORT: "ultra",
        POST_REVIEWS: "yes",
        REVIEW_MAX_BUDGET_USD: "0",
      }),
    (e) =>
      e instanceof ConfigError &&
      [
        "MAX_CONCURRENT_REVIEWS",
        "REVIEW_EFFORT",
        "POST_REVIEWS",
        "REVIEW_MAX_BUDGET_USD",
      ].every((k) => e.message.includes(k)),
  );
  assert.throws(
    () => loadConfig({ MAX_CONCURRENT_REVIEWS: "0" }),
    (e) =>
      e instanceof ConfigError &&
      /MAX_CONCURRENT_REVIEWS: Too small/.test(e.message),
  );
});

test("parses lists, booleans and escaped private keys", () => {
  const c = loadConfig({
    ALLOWED_REPOS: " Acme/App , acme/lib,",
    POST_REVIEWS: "1",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----\\nabc",
  });
  assert.deepEqual(c.ALLOWED_REPOS, ["acme/app", "acme/lib"]);
  assert.equal(c.POST_REVIEWS, true);
  assert.equal(c.GITHUB_APP_PRIVATE_KEY, "-----BEGIN-----\nabc");
});

test("the service needs a webhook secret and complete GitHub auth", () => {
  assert.throws(
    () => checkServiceConfig(loadConfig({ GITHUB_TOKEN: "t" })),
    /GITHUB_WEBHOOK_SECRET/,
  );
  assert.throws(
    () =>
      checkServiceConfig(
        loadConfig({ GITHUB_WEBHOOK_SECRET: "s", GITHUB_APP_ID: "1" }),
      ),
    /set both/,
  );
  assert.throws(
    () => checkServiceConfig(loadConfig({ GITHUB_WEBHOOK_SECRET: "s" })),
    /GitHub auth/,
  );
  checkServiceConfig(
    loadConfig({ GITHUB_WEBHOOK_SECRET: "s", GITHUB_TOKEN: "t" }),
  );
});

test("cost limits have safe defaults and 0 turns the daily cap off", () => {
  const c = loadConfig({});
  assert.equal(c.REVIEW_BUDGET_USD, 12);
  assert.equal(c.REVIEW_MAX_PARALLEL_PASSES, 2);
  assert.equal(c.DAILY_BUDGET_USD, 50);
  assert.equal(loadConfig({ DAILY_BUDGET_USD: "0" }).DAILY_BUDGET_USD, 0);
  assert.throws(
    () => loadConfig({ REVIEW_MAX_PARALLEL_PASSES: "0" }),
    ConfigError,
  );
});

test("one review pass is the default; REVIEW_SINGLE_PASS=false runs one per REVIEW.md pass", () => {
  assert.equal(reviewOptions(loadConfig({})).singlePass, true);
  assert.equal(
    reviewOptions(loadConfig({ REVIEW_SINGLE_PASS: "false" })).singlePass,
    false,
  );
});
