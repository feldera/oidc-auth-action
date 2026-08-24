#!/bin/sh
# Print a GitHub Actions OIDC JWT for a Feldera instance to accept as a bearer
# token. fda runs this once per invocation through FELDERA_AUTH_TOKEN_COMMAND,
# so a job outlives the five-minute lifetime of any single token.
#
# Usage: mint-token.sh [audience]
#
# The audience falls back to FELDERA_OIDC_AUDIENCE; empty means GitHub's
# default, the owning organization's URL.
#
# Tokens are cached for four minutes in RUNNER_TEMP, readable only by the
# runner user: the Actions OIDC endpoint rate limits per job, so a burst of
# client calls mints once rather than once per call.
set -eu

audience="${1:-${FELDERA_OIDC_AUDIENCE:-}}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?the job needs permissions: id-token: write}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?the job needs permissions: id-token: write}"

token_url="$ACTIONS_ID_TOKEN_REQUEST_URL"
cache_key=default
if [ -n "$audience" ]; then
    # Kept to characters that need no URL escaping, so this stays free of jq
    # and python: the job containers are not guaranteed to have either.
    if ! printf '%s' "$audience" | grep -qE '^[A-Za-z0-9._~:-]+$'; then
        echo "ERROR: audience '$audience' has characters that need escaping" >&2
        exit 1
    fi
    token_url="${token_url}&audience=${audience}"
    cache_key="$audience"
fi

cache_file="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/feldera-oidc-${cache_key}.jwt"
if [ -s "$cache_file" ] && [ -n "$(find "$cache_file" -mmin -4 2>/dev/null)" ]; then
    cat "$cache_file"
    exit 0
fi

response=$(curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$token_url")
# A JWT is base64url plus dots, so there is no JSON string escaping to undo.
# Allow whitespace around the colon rather than assuming compact JSON, and
# confirm the result really is a three-segment token: a partial match here
# would otherwise sail on as a bogus credential.
token=$(printf '%s' "$response" | sed -e 's/.*"value"[[:space:]]*:[[:space:]]*"//' -e 's/".*//')
if ! printf '%s' "$token" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'; then
    echo "ERROR: no JWT in GitHub's OIDC response" >&2
    exit 1
fi

umask 077
printf '%s' "$token" >"$cache_file"
printf '%s' "$token"
