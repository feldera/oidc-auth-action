"use strict";

const fs = require("node:fs");

const pid = Number(process.env.STATE_refresherPid || 0);
const tokenFile = process.env.STATE_tokenFile || "";
const logFile = process.env.STATE_logFile || "";

// Whether the refresher survived the job decides how to read a mid-run 401, so
// establish it before the kill makes it unknowable.
let wasRunning = false;
if (pid) {
  try {
    process.kill(pid, 0);
    wasRunning = true;
  } catch {
    // No such process: it exited or was killed during the job.
  }
}

if (wasRunning) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Raced with its own exit, which is the outcome this step wants.
  }
} else if (pid) {
  console.log("::warning::the token refresher was no longer running when the job ended");
}

// Nothing the refresher logs carries the token, so this is safe to print, and
// it is the only record of a mint that failed.
if (logFile) {
  try {
    const log = fs.readFileSync(logFile, "utf8").trimEnd();
    if (log) {
      console.log("Token refresher log:");
      console.log(log);
    }
  } catch {
    // No log to show.
  }
}

for (const file of [tokenFile, `${tokenFile}.next`, logFile]) {
  if (file) fs.rmSync(file, { force: true });
}

console.log(tokenFile ? `Stopped the refresher and removed ${tokenFile}` : "No token to remove");
