# feldera/oidc-auth-action

Authenticate with [Feldera](https://feldera.com) instances from GitHub Actions
using the job's OIDC token.

```yaml
- uses: feldera/oidc-auth-action@<sha> # v4.0.1
```

Mints the job's GitHub OIDC token and refreshes it for as long as the
job runs. Exports `FELDERA_OIDC_TOKEN_FILE`, the path of the file that
holds it. `fda` (0.340.0 or later) reads that file on every invocation,
so it is authenticated as soon as this action has finished.

Setup: First in your YAML and second adding your trust credentials
in the instance.

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
      - uses: feldera/oidc-auth-action@<sha> # v4.0.1
        with:
          host: https://feldera.example.com

      - uses: feldera/fda-install-action@<sha> # v1.0.0
      - run: fda pipelines # FELDERA_HOST and the token are already set
```

#### Inputs

| Input | Default | Meaning |
|---|---|---|
| `host` | `$FELDERA_HOST` | Feldera API URL. Exported as `FELDERA_HOST` and used to verify the token. With neither this nor the environment variable, the credential is wired up but nothing is verified. |
| `audience` | `""` | Audience to request on the token. Empty means GitHub's default, the owning organization's URL. Set it where the trust identifies the workflow by audience rather than by a workflow-scoped subject claim. |

#### Exports

| Variable | Contents |
|---|---|
| `FELDERA_OIDC_TOKEN_FILE` | Path of the token file, mode 0600, rewritten atomically on every refresh. `fda` reads it directly; other clients read it per request. |
| `FELDERA_HOST` | The resolved host, when one is known. |
| `FELDERA_OIDC_AUDIENCE` | The audience the tokens carry. |

#### Certificates

TLS connections need valid certificates. When an instance uses a certificate from an internal authority,
make sure to point `NODE_EXTRA_CA_CERTS` at that authority for the job.

### 2. Register a trust on the instance

A Feldera instance accepts a foreign token only where a trust relationship
matches its issuer, subject and (optionally) audience. Register one per
workflow, as a tenant admin or owner:

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
- uses: feldera/oidc-auth-action@<sha> # v4.0.1
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

Note: any workflow in the repository can request any audience, so it distinguishes
workflows without enforcing the boundary the way a subject claim does.

## Other clients

`fda` reads `FELDERA_OIDC_TOKEN_FILE` itself. Anything else reads the file,
once per request rather than once per job:

```bash
curl -H "Authorization: Bearer $(cat "$FELDERA_OIDC_TOKEN_FILE")" "$FELDERA_HOST/v0/config"
```

For Python, hand the SDK a callable rather than a string. It is re-resolved per
request and retried once on `401`, so a token that lapses mid-run is replaced:

```python
import os, pathlib
from feldera.rest.feldera_client import FelderaClient

def github_oidc_token() -> str:
    return pathlib.Path(os.environ["FELDERA_OIDC_TOKEN_FILE"]).read_text().strip()

client = FelderaClient(api_key=github_oidc_token)
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no OIDC token request URL` | The job is missing `permissions: id-token: write`. A reusable workflow also needs the *calling* job to grant it. |
| The action fails with `rejected the token` | No trust matches. Compare the trust's `iss`, `sub` and `aud` against the token; a subject pinned to one branch will not match another. |
| `401` partway through a long run | A client read the file once instead of per request. Where it does read per request, check the refresher log the post step printed: a run of failed mints, or a refresher that stopped, leaves an expired token in the file. |
| `401` from every `fda` call, with a correct trust | An `fda` older than 0.340.0, which reads `FELDERA_AUTH_TOKEN_COMMAND` (v3 of this action) and not the file. |
| `cannot be used with '--oidc-token-file'` | The job also sets `FELDERA_API_KEY`; `fda` takes one credential. |
| `invalid API key` with a correct trust | A client older than 0.327.0 stringifying a callable credential. |
