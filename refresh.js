"use strict";

const fs = require("node:fs");
const {
  REFRESH_SECONDS,
  RETRY_AFTER_FAILURE_SECONDS,
  MAX_REFRESH_SECONDS,
  mintToken,
  secondsUntilExpiry,
  writeToken,
} = require("./oidc");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Keep `tokenFile` holding an unexpired token until the file goes away or
 * `maxSeconds` passes.
 *
 * The clock, the sleep, the mint and the write are injected so a test can
 * drive the schedule without waiting minutes or reaching GitHub.
 */
async function refreshLoop({
  tokenFile,
  audience = "",
  intervalSeconds = REFRESH_SECONDS,
  retrySeconds = RETRY_AFTER_FAILURE_SECONDS,
  maxSeconds = MAX_REFRESH_SECONDS,
  now = Date.now,
  wait = sleep,
  mint = mintToken,
  write = writeToken,
  exists = fs.existsSync,
  log = () => {},
}) {
  const started = now();
  let delayMs = intervalSeconds * 1000;

  while (now() - started < maxSeconds * 1000) {
    await wait(delayMs);
    // The post step removes the file, which is also how it says stop.
    if (!exists(tokenFile)) {
      log("token file is gone, stopping");
      return;
    }

    const attemptedAt = now();
    try {
      const token = await mint(audience);
      write(tokenFile, token);
      const life = secondsUntilExpiry(token, now());
      log(`refreshed, good for ${life === null ? "an unknown number of" : life} seconds`);
      delayMs = intervalSeconds * 1000;
    } catch (error) {
      // Whatever is already in the file still has most of its life: the
      // interval is a fraction of the lifetime precisely so that a lost mint
      // is recoverable. Say so, and come back soon rather than next cycle.
      log(`mint failed (${error.message}), retrying in ${retrySeconds}s`);
      delayMs = retrySeconds * 1000;
    }
    // Charge the attempt against the wait. Without this the period is the
    // interval plus however long minting took, and a job long enough
    // accumulates that drift until the interval reaches the token's lifetime.
    delayMs = Math.max(0, delayMs - (now() - attemptedAt));
  }
  log(`stopping after ${maxSeconds}s`);
}

async function main() {
  const logFile = process.env.FELDERA_OIDC_REFRESH_LOG;
  const log = (message) => {
    // The post step prints this into the job log. Nothing written here carries
    // the token itself.
    try {
      if (logFile) fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // A log that cannot be written must not stop the refreshing.
    }
  };

  await refreshLoop({
    tokenFile: process.env.FELDERA_OIDC_TOKEN_FILE,
    audience: process.env.FELDERA_OIDC_AUDIENCE || "",
    intervalSeconds: Number(process.env.FELDERA_OIDC_REFRESH_SECONDS || REFRESH_SECONDS),
    log,
  });
}

if (require.main === module) main();

module.exports = { refreshLoop };
