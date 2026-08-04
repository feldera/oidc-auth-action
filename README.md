# feldera/oidc-auth-action

Authenticate to a [Feldera](https://feldera.com) instance from GitHub Actions
with the job's OIDC token, instead of a stored API key.

```yaml
- uses: feldera/oidc-auth-action@<sha> # v1.1.0
```

Pin the SHA rather than a tag: this action runs inside your job and handles a
credential.

Requests the workflow job's GitHub OIDC token and exports it as
`FELDERA_API_KEY`, which every Feldera client reads. The token is the
credential: nothing is stored in repository secrets and no API key is created.

It takes two sides to work, and both are described below. Only the first lives
in your workflow; skipping the second is the usual reason a job gets a `401`.

### 1. Ask for the token

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
      - uses: feldera/oidc-auth-action@<sha> # v1.1.0
        with:
          host: https://feldera.example.com

      - run: fda pipelines # FELDERA_HOST and FELDERA_API_KEY are already set
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
| `host` | `$FELDERA_HOST` | Feldera API URL. Exported as `FELDERA_HOST` and used to verify the token. With neither this nor the environment variable, the token is exported but nothing is verified. |
| `audience` | `""` | Audience to request on the token. Empty means GitHub's default, the owning organization's URL. Set it where the trust identifies the workflow by audience rather than by a workflow-scoped subject claim. |

#### Exports

| Variable | Contents |
|---|---|
| `FELDERA_API_KEY` | The OIDC token, masked in logs |
| `FELDERA_HOST` | The resolved host, when one is known |
| `FELDERA_OIDC_AUDIENCE` | The audience the token was issued for, for clients that re-mint it |

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
- uses: feldera/oidc-auth-action@<sha> # v1.1.0
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

## Token lifetime in long jobs

A GitHub OIDC token expires well inside the runtime of a long test job, and the
instance checks `exp` on every request. A fixed token therefore starts failing
partway through a run that outlives it.

For Python, hand the SDK a callable instead of a string. It is re-resolved per
request and retried once on `401`, so a token that lapses mid-run is replaced:

```python
import json, os, urllib.parse, urllib.request
from feldera.rest.feldera_client import FelderaClient

def github_oidc_token() -> str:
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    audience = os.environ.get("FELDERA_OIDC_AUDIENCE")
    if audience:
        url += "&audience=" + urllib.parse.quote(audience, safe="")
    request = urllib.request.Request(url)
    request.add_header(
        "Authorization", f"bearer {os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}"
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["value"]

client = FelderaClient(api_key=github_oidc_token)
```

The action exports `FELDERA_OIDC_AUDIENCE` alongside the token so the refresh
asks for the audience the token was issued for.

Callable credentials need `feldera >= 0.327.0`. Earlier clients format the
callable into the `Authorization` header instead of calling it, which reaches
the server as a malformed credential and returns an opaque `401`. Put the floor
in your dependency metadata, since nothing in that error names the client.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no OIDC token request URL` | The job is missing `permissions: id-token: write`. A reusable workflow also needs the *calling* job to grant it. |
| The action fails with `rejected the token` | No trust matches. Compare the trust's `iss`, `sub` and `aud` against the token; a subject pinned to one branch will not match another. |
| `401` partway through a long run | The token expired. Use a callable credential, above. |
| `invalid API key` with a correct trust | A client older than 0.327.0 stringifying a callable credential. |
