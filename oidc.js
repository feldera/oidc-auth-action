"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A GitHub OIDC token lives five minutes.
const TOKEN_LIFETIME_SECONDS = 300;

// Re-minting has to survive a failed mint, not just a successful one: whatever
// is already in the file has to outlive the gap until the next write. Missing
// one cycle costs `2 * REFRESH_SECONDS` of token life and missing two costs
// three intervals, so 90 seconds absorbs two consecutive failures and still
// leaves half a minute, at 40 requests across a one-hour job. Widening this
// towards the lifetime is what turns a single lost mint into an outage: at 240
// seconds one lost mint stranded every reader for two minutes.
const REFRESH_SECONDS = 90;

// A lost mint is worth another attempt immediately, not at the next cycle.
// Waiting a full interval was the difference between one slow request and a
// window in which every reader's token had expired.
const RETRY_AFTER_FAILURE_SECONDS = 10;

// Six hours of refreshing bounds a loop whose post step never ran, on a runner
// killed hard enough to skip cleanup but not hard enough to take the process
// with it. Expressed as a duration, so changing the interval cannot quietly
// change the ceiling.
const MAX_REFRESH_SECONDS = 6 * 60 * 60;

// A JWT is base64url plus dots. Anything else means GitHub answered with
// something other than a token, which must not travel on as a credential.
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// Reaching the instance is worth waiting on: it may still be starting.
const INSTANCE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000];

// Minting is not. The refresh loop retries on its own schedule, and a chain
// that sleeps longer than the interval delays the write it is trying to save.
const MINT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

function isTransient(status) {
  return status === 429 || status >= 500;
}

/** fetch, retrying network errors and 429/5xx answers with doubling delays. */
async function fetchWithRetry(url, options, delaysMs = INSTANCE_RETRY_DELAYS_MS) {
  for (const delayMs of delaysMs) {
    let failure;
    try {
      const response = await fetch(url, options);
      if (!isTransient(response.status)) return response;
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = error.message;
    }
    console.log(`Transient failure (${failure}), retrying in ${delayMs / 1000}s`);
    await new Promise((done) => setTimeout(done, delayMs));
  }
  // The last attempt's failure is the caller's to report.
  return fetch(url, options);
}

/** Ask GitHub for an OIDC token for `audience` ("" means GitHub's default). */
async function mintToken(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "no OIDC token request URL; the job needs permissions: id-token: write",
    );
  }

  const url = audience
    ? `${requestUrl}&audience=${encodeURIComponent(audience)}`
    : requestUrl;
  const response = await fetchWithRetry(
    url,
    { headers: { authorization: `bearer ${requestToken}` } },
    MINT_RETRY_DELAYS_MS,
  );
  if (!response.ok) {
    throw new Error(`GitHub's OIDC endpoint answered HTTP ${response.status}`);
  }

  const token = (await response.json()).value ?? "";
  if (!JWT.test(token)) {
    throw new Error("no JWT in GitHub's OIDC response");
  }
  return token;
}

/**
 * Seconds of life left in `token`, or null where it carries no readable `exp`.
 *
 * The signature is GitHub's to make and the instance's to check. Reading the
 * claim unverified is enough to keep an expired token out of the file, which
 * is the only thing this decides.
 */
function secondsUntilExpiry(token, nowMs = Date.now()) {
  const payload = String(token).split(".")[1];
  if (!payload) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims?.exp !== "number") return null;
  return claims.exp - Math.floor(nowMs / 1000);
}

/** One file per audience, so two steps asking for different ones coexist. */
function tokenFileFor(audience) {
  const slug = (audience || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), `feldera-token-${slug}`);
}

/** Where the refresher records what it did, next to the token it maintains. */
function logFileFor(tokenFile) {
  return `${tokenFile}.log`;
}

/** Write through a staging file: a reader never sees half a token. */
function writeToken(file, token) {
  // An expired token is worse than a stale one: every reader presents it and
  // every request fails. Keeping the previous contents at least leaves the
  // window in which the old token is still good.
  const remaining = secondsUntilExpiry(token);
  if (remaining !== null && remaining <= 0) {
    throw new Error(`refusing to write a token that expired ${-remaining}s ago`);
  }
  const staging = `${file}.next`;
  fs.writeFileSync(staging, token, { mode: 0o600 });
  // writeFileSync honours `mode` only when it creates the file, and this one
  // survives from the previous refresh.
  fs.chmodSync(staging, 0o600);
  fs.renameSync(staging, file);
}

function exportVariable(name, value) {
  fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
  process.env[name] = value;
}

function saveState(name, value) {
  fs.appendFileSync(process.env.GITHUB_STATE, `${name}=${value}\n`);
}

function mask(value) {
  console.log(`::add-mask::${value}`);
}

module.exports = {
  TOKEN_LIFETIME_SECONDS,
  REFRESH_SECONDS,
  RETRY_AFTER_FAILURE_SECONDS,
  MAX_REFRESH_SECONDS,
  INSTANCE_RETRY_DELAYS_MS,
  MINT_RETRY_DELAYS_MS,
  fetchWithRetry,
  mintToken,
  secondsUntilExpiry,
  tokenFileFor,
  logFileFor,
  writeToken,
  exportVariable,
  saveState,
  mask,
};
