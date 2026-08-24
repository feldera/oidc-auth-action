# feldera/oidc-auth-action

Authenticate to a [Feldera](https://feldera.com) instance from GitHub Actions
with the job's OIDC token, instead of a stored API key.

```yaml
- uses: feldera/oidc-auth-action@<sha> # v2.0.0
```

Pin the SHA rather than a tag: this action runs inside your job and handles a
credential.

Exports `FELDERA_AUTH_TOKEN_COMMAND`, a command that mints the job's GitHub
OIDC token, which `fda` runs once per invocation.

It takes two sides to work, and both are described below. Only the first lives
in your workflow; skipping the second is the usual reason a job gets a `401`.

### 1. Wire up the credential

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # without this there is no token to request
    env:
      FELDERA_HOST: https://feldera.example.com
    steps:
      - uses: feldera/oidc-auth-action@<sha> # v2.0.0
        with:
          host: https://feldera.example.com

      - run: fda pipelines # FELDERA_HOST and the token command are already set
```

Given a host, the action reads `/v0/config` with the token before finishing. A
missing or mismatched trust therefore fails this step, naming the host and the
audience it presented, instead of surfacing as a `401` from whatever the job
does next:

```
Authenticated to https://feldera.example.com (Feldera 0.327.0)
```

#### Inputs

| Input | Default | Meaning |
|---|---|---|
| `host` | `$FELDERA_HOST` | Feldera API URL. Exported as `FELDERA_HOST` and used to verify the token. With neither this nor the environment variable, the credential is wired up but nothing is verified. |
| `audience` | `""` | Audience to request on the token. Empty means GitHub's default, the owning organization's URL. Set it where the trust identifies the workflow by audience rather than by a workflow-scoped subject claim. |

#### Exports

| Variable | Contents |
|---|---|
| `FELDERA_AUTH_TOKEN_COMMAND` | Path to the mint script plus the audience. `fda` reads it directly; other clients run it themselves |
| `FELDERA_HOST` | The resolved host, when one is known |
| `FELDERA_OIDC_AUDIENCE` | The audience the tokens carry, for clients that mint their own |

#### Certificates

TLS is always verified, and there is deliberately no option to skip it. Where an
instance presents a certificate from an internal authority, point
`CURL_CA_BUNDLE` at that authority for the job.

### 2. Register a trust on the instance

A Feldera instance accepts a foreign token only where a trust relationship
matches its issuer, subject and (optionally) audience. Register one per
workflow, as a tenant admin:

```bash
fda oidc-trust create github-ci \
  --issuer https://token.actions.githubusercontent.com \
  --subject 'repo:my-org/my-repo:ref:refs/heads/*' \
  --audience https://github.com/my-org \
  --role write
```

or through the Python SDK:

```python
client.create_oidc_trust(
    name="github-ci",
    issuer="https://token.actions.githubusercontent.com",
    subject="repo:my-org/my-repo:ref:refs/heads/*",
    audience="https://github.com/my-org",
    role="write",
)
```

`*` is a wildcard in `subject` and `audience`. A trust grants at most `admin`;
the platform-wide `owner` role is configuration only.

## Scoping a trust to one workflow

GitHub's default `sub` claim is `repo:ORG/REPO:ref:refs/heads/BRANCH`, which
names the repository and the branch but not the workflow. Two ways to narrow it
to a single workflow, on any branch:

**By subject.** Set the repository's OIDC subject template to include
`job_workflow_ref`, once per repository:

```bash
gh api -X PUT /repos/ORG/REPO/actions/oidc/customization/sub \
  --input - <<'JSON'
{"use_default": false, "include_claim_keys": ["repo", "job_workflow_ref"]}
JSON
```

`sub` then reads
`repo:ORG/REPO:job_workflow_ref:ORG/REPO/.github/workflows/test.yml@refs/heads/BRANCH`,
and the trust matches it with a trailing `@*`. `job_workflow_ref` names the file
the job is *defined* in, so one trust covers a reusable workflow no matter which
workflow calls it.

Check what else consumes `sub` before changing the template. Cloud trust
policies commonly match it, and a condition pinning an exact subject stops
matching. Prefix patterns such as `repo:ORG/REPO:*` keep working, because the
customized subject still starts with `repo:ORG/REPO`.

**By audience.** Where the subject template has to stay at the default, have the
workflow ask for its own audience and pin that on the trust:

```yaml
- uses: feldera/oidc-auth-action@<sha> # v2.0.0
  with:
    audience: my-repo-integration-tests
```

```bash
fda oidc-trust create integration-tests \
  --issuer https://token.actions.githubusercontent.com \
  --subject 'repo:my-org/my-repo:*' \
  --audience my-repo-integration-tests \
  --role write
```

This is weaker: any workflow in the repository can request any audience, so it
distinguishes workflows without enforcing the boundary the way a subject claim
does.

## Other clients

`fda` reads `FELDERA_AUTH_TOKEN_COMMAND` itself. Anything else runs the command
the same way the action does:

```bash
curl -H "Authorization: Bearer $($FELDERA_AUTH_TOKEN_COMMAND)" "$FELDERA_HOST/v0/config"
```

For Python, hand the SDK a callable rather than a string. It is re-resolved per
request and retried once on `401`, so a token that lapses mid-run is replaced:

```python
import os, subprocess
from feldera.rest.feldera_client import FelderaClient

def github_oidc_token() -> str:
    command = os.environ["FELDERA_AUTH_TOKEN_COMMAND"]
    return subprocess.run(command, shell=True, capture_output=True, text=True,
                          check=True, timeout=30).stdout.strip()

client = FelderaClient(api_key=github_oidc_token)
```

Callable credentials need `feldera >= 0.327.0`. Earlier clients format the
callable into the `Authorization` header instead of calling it, which reaches
the server as a malformed credential and returns an opaque `401`. Put the floor
in your dependency metadata, since nothing in that error names the client.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no OIDC token request URL` | The job is missing `permissions: id-token: write`. A reusable workflow also needs the *calling* job to grant it. |
| The action fails with `rejected the token` | No trust matches. Compare the trust's `iss`, `sub` and `aud` against the token; a subject pinned to one branch will not match another. |
| `401` partway through a long run | A client held one token instead of running the command per request. |
| `cannot be used with '--auth-token-command'` | The job also sets `FELDERA_API_KEY`, and this `fda` predates the precedence rule. |
| `invalid API key` with a correct trust | A client older than 0.327.0 stringifying a callable credential. |
