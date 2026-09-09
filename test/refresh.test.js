"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  REFRESH_SECONDS,
  RETRY_AFTER_FAILURE_SECONDS,
  TOKEN_LIFETIME_SECONDS,
  secondsUntilExpiry,
} = require("../oidc");
const { refreshLoop } = require("../refresh");
const { fakeToken } = require("./helpers");

// Tests of what the loop does use their own schedule, so that changing the
// shipped constants fails only the tests that are about the shipped constants.
const INTERVAL = 100;
const RETRY = 10;

/**
 * Run the loop on a virtual clock and report how long the token file held a
 * token no instance would accept.
 *
 * That number is the whole point of the schedule: readers see a 401 for
 * exactly as long as it is above zero.
 */
async function simulate({
  intervalSeconds,
  retrySeconds,
  lifetimeSeconds = TOKEN_LIFETIME_SECONDS,
  horizonSeconds,
  mintSeconds = 0,
  failAttempts = 0,
  removeFileAt = null,
}) {
  let nowMs = 0;
  let attempts = 0;
  const now = () => nowMs;
  const wait = async (ms) => {
    nowMs += ms;
  };

  const mint = async () => {
    attempts += 1;
    nowMs += mintSeconds * 1000;
    if (attempts <= failAttempts) throw new Error("GitHub's OIDC endpoint answered HTTP 503");
    return fakeToken(Math.floor(nowMs / 1000) + lifetimeSeconds);
  };

  // The action mints and writes once before spawning the refresher.
  const writes = [{ atSeconds: 0, expirySeconds: lifetimeSeconds }];
  const write = (_file, token) => {
    writes.push({
      atSeconds: nowMs / 1000,
      expirySeconds: nowMs / 1000 + secondsUntilExpiry(token, nowMs),
    });
  };

  await refreshLoop({
    tokenFile: "/virtual/token",
    intervalSeconds,
    retrySeconds,
    maxSeconds: horizonSeconds,
    now,
    wait,
    mint,
    write,
    exists: () => removeFileAt === null || nowMs / 1000 < removeFileAt,
  });

  // A reader is rejected from the moment the file's token expires until the
  // next write replaces it.
  let strandedSeconds = 0;
  for (let i = 0; i < writes.length; i++) {
    const until = i + 1 < writes.length ? writes[i + 1].atSeconds : horizonSeconds;
    strandedSeconds += Math.max(0, until - writes[i].expirySeconds);
  }
  return { writes, attempts, strandedSeconds, endedAtSeconds: nowMs / 1000 };
}

test("the settings that caused the CI outage strand readers for three minutes", async () => {
  // https://github.com/feldera/feldera/issues/7048: re-minting every 240s
  // against a 300s token, and waiting a whole interval after a lost mint. The
  // file then held a token that expired `2 * 240 - 300` seconds before the
  // next write, and every request in that window was rejected. What CI saw was
  // 120s of it, because the manager allows 60s of clock skew on top of `exp`;
  // both reported runs failed 122s after a cycle boundary. An action cannot
  // count on a reader's leeway, so the schedule has to hold on `exp` alone.
  const outage = await simulate({
    intervalSeconds: 240,
    retrySeconds: 240,
    horizonSeconds: 1200,
    failAttempts: 1,
  });
  assert.equal(outage.strandedSeconds, 180);
});

test("one lost mint strands nobody at the shipped settings", async () => {
  const run = await simulate({
    intervalSeconds: REFRESH_SECONDS,
    retrySeconds: RETRY_AFTER_FAILURE_SECONDS,
    horizonSeconds: 1200,
    failAttempts: 1,
  });
  assert.equal(run.strandedSeconds, 0);
});

test("a run of lost mints strands nobody until the token's life is spent", async () => {
  // 90s to the first attempt, then one every 10s: twenty-one attempts fit
  // inside the 300s the file's token has left.
  const survivable = await simulate({
    intervalSeconds: REFRESH_SECONDS,
    retrySeconds: RETRY_AFTER_FAILURE_SECONDS,
    horizonSeconds: 1200,
    failAttempts: 20,
  });
  assert.equal(survivable.strandedSeconds, 0);

  // Past that the token is simply gone, and the measurement says so rather
  // than reporting zero for every input.
  const overrun = await simulate({
    intervalSeconds: REFRESH_SECONDS,
    retrySeconds: RETRY_AFTER_FAILURE_SECONDS,
    horizonSeconds: 1200,
    failAttempts: 30,
  });
  assert.ok(overrun.strandedSeconds > 0);
});

test("a slow mint does not push the schedule later and later", async () => {
  const mintSeconds = 5;
  const run = await simulate({
    intervalSeconds: INTERVAL,
    retrySeconds: RETRY,
    horizonSeconds: 3600,
    mintSeconds,
  });

  // Charging the mint against the wait keeps write k at k intervals plus one
  // mint. Without it the gap grows by `mintSeconds` every cycle until the
  // period reaches the token's lifetime.
  run.writes.slice(1).forEach((write, index) => {
    assert.equal(write.atSeconds, INTERVAL * (index + 1) + mintSeconds);
  });
  assert.equal(run.strandedSeconds, 0);
});

test("the loop stops when the post step removes the token file", async () => {
  const run = await simulate({
    intervalSeconds: INTERVAL,
    retrySeconds: RETRY,
    horizonSeconds: 3600,
    removeFileAt: 250,
  });
  // The initial write, then refreshes at 100s and 200s; the 300s cycle finds
  // the file gone and stops.
  assert.equal(run.writes.length, 3);
  assert.equal(run.endedAtSeconds, 300);
});

test("the loop stops at its wall-clock ceiling", async () => {
  const horizonSeconds = 900;
  const run = await simulate({
    intervalSeconds: INTERVAL,
    retrySeconds: RETRY,
    horizonSeconds,
  });
  assert.equal(run.endedAtSeconds, horizonSeconds);
});

test("a mint that never succeeds keeps being retried, not abandoned", async () => {
  const run = await simulate({
    intervalSeconds: INTERVAL,
    retrySeconds: RETRY,
    horizonSeconds: 600,
    failAttempts: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(run.writes.length, 1);
  // One interval to the first attempt, then one every `RETRY` to the horizon.
  assert.equal(run.attempts, 1 + (600 - INTERVAL) / RETRY);
});
