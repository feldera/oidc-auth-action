"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  MINT_RETRY_DELAYS_MS,
  REFRESH_SECONDS,
  RETRY_AFTER_FAILURE_SECONDS,
  TOKEN_LIFETIME_SECONDS,
  fetchWithRetry,
  mintToken,
  secondsUntilExpiry,
  writeToken,
} = require("../oidc");
const { fakeToken } = require("./helpers");

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oidc-test-")), "token");
}

test("the refresh interval leaves room for lost mints", () => {
  // Missing one cycle leaves the file's token to cover two intervals and
  // missing two leaves it to cover three. Anything above a third of the
  // lifetime turns a lost mint into a window where every reader is rejected.
  assert.ok(
    3 * REFRESH_SECONDS < TOKEN_LIFETIME_SECONDS,
    `${REFRESH_SECONDS}s interval does not absorb two lost mints in a ${TOKEN_LIFETIME_SECONDS}s lifetime`,
  );
  assert.ok(RETRY_AFTER_FAILURE_SECONDS < REFRESH_SECONDS);
  // A mint may not spend so long retrying that it outlives its own cycle.
  const chainMs = MINT_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  assert.ok(chainMs < REFRESH_SECONDS * 1000);
});

test("secondsUntilExpiry reads exp", () => {
  const nowMs = 1_000_000_000_000;
  const nowSeconds = Math.floor(nowMs / 1000);
  assert.equal(secondsUntilExpiry(fakeToken(nowSeconds + 300), nowMs), 300);
  assert.equal(secondsUntilExpiry(fakeToken(nowSeconds - 42), nowMs), -42);
});

test("secondsUntilExpiry reports nothing rather than guessing", () => {
  assert.equal(secondsUntilExpiry(fakeToken(null), Date.now()), null);
  assert.equal(secondsUntilExpiry(fakeToken("soon"), Date.now()), null);
  assert.equal(secondsUntilExpiry("not.a.jwt", Date.now()), null);
  assert.equal(secondsUntilExpiry("opaque", Date.now()), null);
  assert.equal(secondsUntilExpiry("", Date.now()), null);
});

test("writeToken replaces the file atomically and privately", () => {
  const file = tempFile();
  const token = fakeToken(Math.floor(Date.now() / 1000) + 300);
  writeToken(file, token);
  assert.equal(fs.readFileSync(file, "utf8"), token);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(`${file}.next`));

  const next = fakeToken(Math.floor(Date.now() / 1000) + 600);
  writeToken(file, next);
  assert.equal(fs.readFileSync(file, "utf8"), next);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("writeToken refuses an expired token and keeps the older one", () => {
  const file = tempFile();
  const good = fakeToken(Math.floor(Date.now() / 1000) + 300);
  writeToken(file, good);

  const expired = fakeToken(Math.floor(Date.now() / 1000) - 1);
  assert.throws(() => writeToken(file, expired), /expired/);
  // A stale token still has the rest of its life; an expired one has none.
  assert.equal(fs.readFileSync(file, "utf8"), good);
});

test("writeToken accepts a token with no readable expiry", () => {
  const file = tempFile();
  writeToken(file, fakeToken(null));
  assert.equal(fs.readFileSync(file, "utf8"), fakeToken(null));
});

test("fetchWithRetry returns a 4xx without retrying", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response("no", { status: 403 });
  });
  const response = await fetchWithRetry("https://example.test", {}, [1, 1, 1]);
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
});

test("fetchWithRetry rides out a 503", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response("", { status: calls < 3 ? 503 : 200 });
  });
  const response = await fetchWithRetry("https://example.test", {}, [1, 1, 1]);
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test("mintToken names the missing permission", async () => {
  const saved = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  await assert.rejects(() => mintToken(""), /id-token: write/);
  if (saved !== undefined) process.env.ACTIONS_ID_TOKEN_REQUEST_URL = saved;
});

test("mintToken retries a 503 and rejects a body that is not a JWT", async (t) => {
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://token.test/idtoken?api-version=2.0";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-token";
  const token = fakeToken(Math.floor(Date.now() / 1000) + 300);

  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls += 1;
    assert.match(String(url), /audience=feldera-ci/);
    if (calls < 3) return new Response("", { status: 503 });
    return Response.json({ value: token });
  });
  assert.equal(await mintToken("feldera-ci"), token);

  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => Response.json({ value: "sentinel" }));
  await assert.rejects(() => mintToken("feldera-ci"), /no JWT/);

  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
});

test("a failing mint gives up well inside one refresh cycle", async (t) => {
  // The refresh loop is what retries a lost mint. A mint that works through
  // the chain meant for reaching an instance would still be sleeping when its
  // own next cycle came due, delaying the write it exists to produce.
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://token.test/idtoken?api-version=2.0";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-token";

  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response("", { status: 503 });
  });

  const startedMs = Date.now();
  await assert.rejects(() => mintToken("feldera-ci"), /HTTP 503/);
  const elapsedMs = Date.now() - startedMs;

  assert.equal(calls, MINT_RETRY_DELAYS_MS.length + 1);
  assert.ok(
    elapsedMs < (REFRESH_SECONDS * 1000) / 2,
    `a failed mint took ${elapsedMs}ms of a ${REFRESH_SECONDS}s cycle`,
  );

  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
});
