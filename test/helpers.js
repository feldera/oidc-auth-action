"use strict";

/** A JWT-shaped string carrying `exp`, which is all this action reads. */
function fakeToken(expSeconds, extra = {}) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = expSeconds === null ? { ...extra } : { exp: expSeconds, ...extra };
  return `${part({ alg: "RS256" })}.${part(payload)}.c2ln`;
}

module.exports = { fakeToken };
