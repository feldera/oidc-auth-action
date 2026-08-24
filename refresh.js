"use strict";

const fs = require("node:fs");
const { REFRESH_SECONDS, MAX_REFRESH_SECONDS, mintToken, writeToken } = require("./oidc");

async function main() {
  const tokenFile = process.env.FELDERA_OIDC_TOKEN_FILE;
  const audience = process.env.FELDERA_OIDC_AUDIENCE || "";
  const seconds = Number(process.env.FELDERA_OIDC_REFRESH_SECONDS || REFRESH_SECONDS);
  const maxRefreshes = Math.ceil(MAX_REFRESH_SECONDS / seconds);

  for (let refresh = 0; refresh < maxRefreshes; refresh++) {
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
