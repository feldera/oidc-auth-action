"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A GitHub OIDC token lives five minutes. Re-minting every four leaves every
// reader at least a minute of the token's life, and costs 15 requests across a
// one-hour job.
const REFRESH_SECONDS = 240;

// Six hours of refreshing bounds a loop whose post step never ran, on a runner
// killed hard enough to skip cleanup but not hard enough to take the process
// with it. Expressed as a duration, so changing the interval cannot quietly
// change the ceiling.
const MAX_REFRESH_SECONDS = 6 * 60 * 60;

// A JWT is base64url plus dots. Anything else means GitHub answered with
// something other than a token, which must not travel on as a credential.
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

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
  const response = await fetch(url, {
    headers: { authorization: `bearer ${requestToken}` },
  });
  if (!response.ok) {
    throw new Error(`GitHub's OIDC endpoint answered HTTP ${response.status}`);
  }

  const token = (await response.json()).value ?? "";
  if (!JWT.test(token)) {
    throw new Error("no JWT in GitHub's OIDC response");
  }
  return token;
}

/** One file per audience, so two steps asking for different ones coexist. */
function tokenFileFor(audience) {
  const slug = (audience || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), `feldera-token-${slug}`);
}

/** Write through a staging file: a reader never sees half a token. */
function writeToken(file, token) {
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
  REFRESH_SECONDS,
  MAX_REFRESH_SECONDS,
  mintToken,
  tokenFileFor,
  writeToken,
  exportVariable,
  saveState,
  mask,
};
