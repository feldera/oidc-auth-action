"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  REFRESH_SECONDS,
  mintToken,
  tokenFileFor,
  writeToken,
  exportVariable,
  saveState,
  mask,
} = require("./oidc");

async function verify(host, token, audience) {
  let response;
  try {
    response = await fetch(`${host}/v0/config`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new Error(`could not reach ${host}: ${error.message}`);
  }

  const body = await response.text();
  if (response.status === 401 || response.status === 403) {
    const presented = audience || `https://github.com/${process.env.GITHUB_REPOSITORY_OWNER}`;
    throw new Error(
      `${host} rejected the token (HTTP ${response.status}): ${body}\n` +
        "No OIDC trust on that instance matches this workflow's token.\n" +
        "Compare the trust's issuer, subject and audience against the token;\n" +
        `this one carries aud '${presented}'.`,
    );
  }
  if (!response.ok) {
    throw new Error(`${host} answered HTTP ${response.status}: ${body}`);
  }

  let version;
  try {
    version = JSON.parse(body).version;
  } catch {
    // A body that is not JSON still proves the instance accepted the token.
  }
  console.log(version ? `Authenticated to ${host} (Feldera ${version})` : `Authenticated to ${host}`);
}

async function main() {
  const audience = process.env.INPUT_AUDIENCE || "";
  const token = await mintToken(audience);
  mask(token);

  const tokenFile = tokenFileFor(audience);
  writeToken(tokenFile, token);

  // Clients get a file, not the token and not the command that mints it. A
  // step that rebuilds its environment still reads it (claude-code-action
  // deletes ACTIONS_ID_TOKEN_REQUEST_* so an agent cannot mint), and nothing
  // downstream can ask for a different audience.
  exportVariable("FELDERA_OIDC_TOKEN_FILE", tokenFile);
  exportVariable("FELDERA_OIDC_AUDIENCE", audience);

  if (process.env.FELDERA_API_KEY) {
    console.log(
      "::warning::FELDERA_API_KEY is set in this job; fda takes one credential and refuses it next to FELDERA_OIDC_TOKEN_FILE",
    );
  }

  // Detached, so it outlives this step and keeps the file fresh for the whole
  // job. The post step stops it; deleting the file stops it too.
  const refresher = spawn(process.execPath, [path.join(__dirname, "refresh.js")], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      FELDERA_OIDC_TOKEN_FILE: tokenFile,
      FELDERA_OIDC_AUDIENCE: audience,
      FELDERA_OIDC_REFRESH_SECONDS: String(REFRESH_SECONDS),
    },
  });
  refresher.unref();
  saveState("refresherPid", String(refresher.pid));
  saveState("tokenFile", tokenFile);
  console.log(
    `Wired FELDERA_OIDC_TOKEN_FILE (aud ${audience || "default"}), re-minting every ${REFRESH_SECONDS}s`,
  );

  // The input wins over an inherited FELDERA_HOST so a job can point one step
  // at a different instance without rewriting its env.
  const host = (process.env.INPUT_HOST || process.env.FELDERA_HOST || "").replace(/\/+$/, "");
  if (!host) {
    console.log("::notice::No host given and FELDERA_HOST is unset, so the token was not verified");
    return;
  }
  exportVariable("FELDERA_HOST", host);

  // Spend one request proving the instance accepts the token. The alternative
  // is a 401 surfacing from whatever the job does next, which names neither
  // the credential nor the trust that failed to match.
  await verify(host, token, audience);
}

main().catch((error) => {
  const [summary, ...detail] = String(error.message).split("\n");
  console.log(`::error::${summary}`);
  for (const line of detail) console.error(line);
  process.exitCode = 1;
});
