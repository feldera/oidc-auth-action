"use strict";

const fs = require("node:fs");
const { mintToken, writeToken } = require("./oidc");

// Six hours bounds a loop whose post step never ran, on a runner killed hard
// enough to skip cleanup but not hard enough to take the process with it.
const MAX_REFRESHES = 144;

async function main() {
  const tokenFile = process.env.FELDERA_OIDC_TOKEN_FILE;
  const audience = process.env.FELDERA_OIDC_AUDIENCE || "";
  const seconds = Number(process.env.FELDERA_OIDC_REFRESH_SECONDS || 150);

  for (let refresh = 0; refresh < MAX_REFRESHES; refresh++) {
    await new Promise((done) => setTimeout(done, seconds * 1000));
    // The post step removes the file, which is also how it says stop.
    if (!fs.existsSync(tokenFile)) return;
    try {
      writeToken(tokenFile, await mintToken(audience));
    } catch {
      // Leave the last good token in place: it has minutes of life left and
      // the next pass is seconds away.
    }
  }
}

main();
