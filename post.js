"use strict";

const fs = require("node:fs");

const pid = Number(process.env.STATE_refresherPid || 0);
const tokenFile = process.env.STATE_tokenFile || "";

if (pid) {
  try {
    process.kill(pid);
  } catch {
    // Already gone, which is the outcome this step wants.
  }
}

for (const file of [tokenFile, `${tokenFile}.next`]) {
  if (file) fs.rmSync(file, { force: true });
}

console.log(tokenFile ? `Stopped the refresher and removed ${tokenFile}` : "No token to remove");
