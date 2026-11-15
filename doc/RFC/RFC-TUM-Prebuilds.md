# RFC: Prebuilds and build providers

| Field   | Value                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Proposed                                                                                                                                                                      |
| Author  | Matthijs van Henten                                                                                                                                                           |
| Date    | 2026-11-15                                                                                                                                                                    |
| Related | [RFC: Tumpel](RFC-TUM-Tumpel.md), [EDD-003](../EDD/003-credentials.md), [EDD-004](../EDD/004-snapshots-and-transcripts.md), [Dashboard requirements](../product/dashboard.md) |

## Summary

A prebuild installs a repository's dependencies once, ahead of any session, and stores the result. A box then starts with that work done. Tumpel runs no build on its own machines. It asks a build provider that the tenant already uses, such as GitHub Actions or CircleCI, and the provider bills the tenant. Every provider hands back the same thing: a container image layer, uploaded to Tumpel's object storage on presigned URLs. Tumpel stores that layer in the same chunk and pack store as snapshots, so a box reads one format whatever built it. Tumpel also becomes an OpenID Connect issuer. A tenant's cloud account and build provider can then trust short-lived tokens that Tumpel signs, and no tenant stores a cloud key in Tumpel. This RFC adds to RFC: Tumpel and replaces none of it.

## Tenets

The tenets of [RFC: Tumpel](RFC-TUM-Tumpel.md#tenets) hold unchanged. Three of them drive this design: all primitives get wrapped, no standing secrets, and every phase has a time limit and a named failure.

## Problem statement

The guest image holds Ubuntu, git, the GitHub CLI and the harness, and none of a repository's own dependencies ([guest image](../guest-image.md)). A box clones the repository before the harness starts, so anything else the repository needs gets installed inside a turn, on the turn's 3,600 s budget. A snapshot keeps those files for its own session only. Tumpel has no way to build a repository's environment outside a box.

## Proposal

### Prebuilds

A prebuild is a job of its own. Its input is a repository plus one digest over the repository's devcontainer files and lockfiles. Its output is one content-addressed layer. The repository, the input digest and the base image digest form the prebuild's key, so every commit with the same devcontainer, lockfiles and base shares one layer, whatever the harness (EDD-007).

At a session's first turn, the control plane reads those files through the GitHub App, computes the digest and finds the stored prebuild with that key. When one exists, the turn offer names it. The supervisor restores the layer from packs the way it restores a snapshot (EDD-004), and the box boots with three layers: the base image, the prebuild layer and the session's own overlay. The harness layer mounts beside them. A session keeps the prebuild it started with. When no prebuild matches, the box boots from the image alone, as it does now.

### The output contract

Every provider uploads an OCI image layer to presigned object storage URLs that the control plane signs per prebuild. The control plane then cuts the layer into chunks with the snapshot chunker and stores them in the tenant's packs. Chunks the tenant already holds are not stored twice. Boxes only ever see packs. So a provider adapter ends at the upload, and no box code knows which provider built its layer.

### The build provider port

BuildProvider is a port with one operation: start a prebuild for a key, with upload URLs and a deadline. Each adapter reports Done or a named failure. Adapters come in three shapes:

1. CI dispatch. Tumpel triggers a pipeline in the tenant's CI, and the pipeline runs the build. GitHub Actions comes first and CircleCI second; GitLab CI and Bitbucket Pipelines follow.
2. Remote BuildKit. Tumpel sends the build recipe with the request to a hosted BuildKit service. Namespace comes first and is parked; Docker Build Cloud is a later candidate.
3. Ephemeral VM by API. A machine runs the build and is thrown away. A tenant host with the builder capability is the first candidate, and it runs the build without a box. Fly Machines, Ubicloud and Hetzner are later candidates.

A prebuild needs no microVM. It runs the repository's own scripts with read access to the repository and nothing else. It never receives a provider key, a model key or a secret set value.

### Connections

Each provider joins the dashboard's Connections screen as one connection, with the states NotConfigured, NotConnected and Connected. Each adds its own `get`, `start` and `delete` operations and one row in `Connections_list`. The tenant connects its own account at each provider.

## Phases

Phase 1 builds two adapters: GitHub Actions and CircleCI. Both start a CI pipeline on the tenant's account, and both jobs upload through one exchange, with the job's own OIDC token. GitHub dispatches through the existing App, and CircleCI through the tenant's API token. A GitHub token proves one run on one commit. A CircleCI token proves one pipeline, and every job in it holds one. CircleCI registers nothing at the provider side, so a tenant connects it in one step. Its free plan gives 30,000 credits a month. Phase 1 also builds the issuer and publishes both opt-in packages.

Namespace is parked. Its support team takes about a week to register a custom issuer, and the owner has not yet signed up with Namespace. Its code, its connection kind and its documents stay as they are. Nothing extends them until the registration is done.

## Follow-ups

The follow-ups come in the order of the appendix of providers. Each is one spec with its own adapter, connection and proof.

## The OIDC issuer

Each stage serves its issuer on its own hostname: `https://id.dev.tumpel.dev` for `dev` and `https://id.tumpel.dev` for `prod`. The DNS records exist and refuse destruction, and the hostname never moves once a tenant pins it. The issuer serves two documents:

- `/.well-known/openid-configuration`, the discovery document, with `issuer`, `jwks_uri`, `response_types_supported` of `id_token`, `subject_types_supported` of `public`, `claims_supported`, `scopes_supported` and signing algorithm RS256.
- `/.well-known/jwks.json`, the public keys.

A token lives 300 s, the same as a credential grant (EDD-003). The control plane signs each token through the key-store port with a private key sealed like the GitHub App's key.

## Token claims

The `sub` claim is the tenant's scoping lever. It starts with `tenant:<tenantId>`, its fields follow a fixed order, and no field value holds a colon. So a token from one tenant never matches another tenant's trust rule. An example is `tenant:<tenantId>:persona:<personaName>:job:prebuild`. Azure matches `sub` exactly and takes no wildcard, so the format is a contract.

The `aud` claim names one provider per token:

| Provider  | `aud`                                                                                  |
| --------- | -------------------------------------------------------------------------------------- |
| AWS       | The client ID the tenant registers on its IAM OIDC provider                            |
| GCP       | The workload identity pool provider's resource URL under `https://iam.googleapis.com/` |
| Azure     | `api://AzureADTokenExchange`                                                           |
| Namespace | `federation.namespaceapis.com`                                                         |

Namespace trusts a custom issuer only after Namespace Support registers it, once for each tenant's workspace. A provider without federation, such as Ubicloud, gets its API token from the tenant's secret set instead. The same issuer can later hand a box a token per turn for scoped cloud access.

## Requirements

### Business requirements

- **BR-1 Faster first turn.** As a tenant member, I want a box to start with the repository's dependencies installed, so that a turn starts on the task.
- **BR-2 My build accounts.** As a tenant, I want prebuilds to run on build accounts I already have, so that I use their free minutes and their bills.
- **BR-3 No cloud keys.** As a tenant owner, I want my cloud accounts to trust Tumpel without a stored key, so that no long-lived cloud key exists.

### Functional requirements

- **FR-1 Start a prebuild.** A tenant member starts a prebuild for a repository and a ref through one MCP tool and one CLI command. The answer names the prebuild, its key and its provider. (BR-1)
- **FR-2 Reuse.** A prebuild with a key the tenant already holds answers with the stored prebuild and starts no job. (BR-1)
- **FR-3 Use at start.** A session's first turn names the matching prebuild, and the session keeps it. With no match, the box starts without a prebuild layer. (BR-1)
- **FR-4 Connect a provider.** A tenant connects GitHub Actions or CircleCI through the Connections model, and later each follow-up provider. (BR-2)
- **FR-5 Named failures.** A prebuild ends Done or Failed. Each failure names its phase: dispatch, build, upload or conversion. (BR-1)
- **FR-6 Federate.** A tenant's AWS, GCP or Azure account trusts the stage's issuer and assumes a role with a Tumpel token. (BR-3)

### Non-functional requirements

- **NFR-1 One format.** A box reads every prebuild from packs, whatever built it.
- **NFR-2 Credential-less builds.** A build holds read access to its repository and nothing else.
- **NFR-3 No cross-tenant `sub`.** No token's `sub` matches a rule written for another tenant.
- **NFR-4 Budgets.** Dispatch, build, upload and conversion each have a budget and a named failure.
- **NFR-5 Token life.** An issuer token lives 300 s.
- **NFR-6 Key overlap.** A key stays in the JWKS for 24 h after its successor starts signing.
- **NFR-7 Algorithm.** The issuer signs RS256.

## Decisions

On 2026-11-15 the following rulings were made:

> we keep github dispatch as the escape hatch. we meet the devs where they are already, and we add 2-3 alternative contenders to prove the infrastructure, those who are generous towards free build minutes and oidc/oauth.

> fine, we do two to start with, but your other recommendations get planned, so we have an easy follow up strategy I can kick off in a few stolen moments.

> tumpel will be oss.

### Rulings

**Tenants opt in through a reusable workflow.** Tumpel publishes the prebuild workflow in the public repository `tumpel/workflows`. The prebuild start commits a short caller workflow through the App, which triggers on `workflow_dispatch` and on a push to its own path and calls `tumpel/workflows/.github/workflows/prebuild.yml@v2` with only the API origin. The App's manifest adds write on Actions, Contents and Workflows, which the dispatch and the commit require. A prebuild never fails because the repository lacks the caller workflow.

**`tumpel/workflows` is the workflow's source.** The workflows move at their own pace, so they live in their own repository. Agents commit there like in any other repository, tag an immutable `vX.Y.Z` and move the major tag `v1` when a change is ready. Skew between the workflow and the API is handled case by case in the change that causes it. Ruled on D6.

**CircleCI is the second adapter, and tenants import the orb `tumpel/prebuild@1` in their own config.** Tumpel commits no file into a tenant repository. Ruled 2026-11-15.

**Tumpel is open source under Apache-2.0.** The repository stays private for now. Anyone can fetch the reusable workflow, the installer and the images. Self-hosting the control plane is supported next to the hosted `tumpel.dev`. Nothing proprietary or secret lives in the repository. Secrets stay in tofu and the key-store port.

**The issuer defaults stand: 300 s token life, 24 h key overlap and RS256.** His ruling: safe default, 2026-11-15.

**The BuildKit client and the conversion of an OCI layer to packs run in the supervisor, on a tenant host that carries a builder role.** No new runtime is added. Ruled under the tenets, 2026-11-15.

**A job gets its upload URLs by presenting its provider's OIDC token.** A URL in the dispatch inputs is a credential in the run's record. GitHub, CircleCI, GitLab and Bitbucket each issue a job token. He took the safe default.

## Implementation notes

### Issuer

The Worker generates each RS256 key itself, at 2048 bits, and a key's `kid` is its RFC 7638 thumbprint. The central table `issuer_keys` holds each private key, sealed under a data key that `SECRETS_KEK` wraps, with the time it starts signing in `signs_from`. A token carries `iss`, `sub`, `aud`, `iat`, `nbf`, `exp` and `jti`. The prebuild `sub` is `tenant:<tenantId>:persona:<name>:job:prebuild`. The Worker var `ISSUER_HOSTNAME` names the issuer's hostname.

### Prebuilds

The input digest covers every file under `.devcontainer/`, `.devcontainer.json` and the root lockfiles that `packages/control-plane/src/prebuild-inputs.ts` lists, as they stand on the default branch. Each file gives one line, `<path>\0<git blob sha>\n`. The lines are sorted by path, and the digest is the sha256 over them. The key stores the repository as `https://github.com/<owner>/<name>` in lower case. Its image digest is the current release's Amd64 base image. Prebuilds build on Amd64 until Arm64 images exist.

The control plane reads the files with the GitHub App's installation token, or else with the persona's `GITHUB_TOKEN`.

### Prebuild start

Each start names its provider. The first check that fails refuses the start, in this order:

1. InvalidRequest: the repository is not a GitHub URL.
2. NotFound: the persona does not exist.
3. NoBuildProvider: the named provider is not connected.
4. HarnessNotInCatalog: the catalog lists no version of the persona's harness that the tenant can run.
5. NoRelease: the stage has published no release.
6. ImageNotReleased: the current release has no Amd64 base image.
7. RepositoryUnreadable: neither token can read the repository. A GitHub Actions start reads with the installation token only, and is refused GitHubNotConnected first when no installation covers the repository's owner.

A repository without a devcontainer.json builds with the default config: `prebuild.mjs` runs `npm ci` when the root holds `package-lock.json` or `npm-shrinkwrap.json`, and nothing otherwise, because npm is the one package manager the guest image carries. The prebuild records `configSource` Default, and the dashboard names that setup. The input digest also covers `package.json`. The dashboard offers a session that commits a devcontainer.json through a pull request.

A start whose key matches a prebuild that is not Failed then returns the newest such prebuild, unless it asks for a rebuild. Past that point, Namespace is refused BuildProviderUnavailable. A GitHub Actions start reads the caller workflow first. It is refused GitHubNotConnected while no App installation covers the repository's owner, GitHubAppPermissionMissing when the installation cannot write Actions, or Contents and Workflows while the caller workflow needs committing, CallerWorkflowRefused when GitHub refuses that commit, and DispatchRefused when GitHub refuses the installation token, Actions are disabled in the repository or GitHub refuses the dispatch; each cause has its own fix. A missing or stale caller workflow is committed, and the commit's push starts the run; the start reads the inputs at that commit and records a new prebuild. A current one is dispatched with no inputs. Either way the prebuild records the commit it read, and the run is picked up by that commit (`doc/github-actions-prebuild.md`). Without a project binding for the repository, a CircleCI start is refused CircleCIProjectMissing. A Namespace connection is refused IssuerMissing while the stage has no issuer.

### Layer upload

A CI prebuild uploads its layer through `POST /v1/prebuilds/{prebuildId}/uploads` and `.../uploads/complete`, with the job's OIDC token as bearer.

- The token's `aud` is the API origin with no trailing slash. A GitHub token's keys come from `<gitHubActionsIssuer>/.well-known/jwks`, and a CircleCI token's from its organization's issuer.
- A GitHub token binds `repository` to the prebuild's repository, `workflow_ref` to `<repository>/<caller workflow>@<ref>`, `ref` to `refs/heads/<default branch>` as the start recorded it, and `event_name` to `push` or `workflow_dispatch`. It binds `sha` to the commit the start recorded and `run_id` to the run that took the prebuild.
- Before the build, the run reads its inputs at `POST /v1/prebuild-inputs` with the same token. The tenant is the one whose installation is on the token's repository owner, and the prebuild is the newest Dispatched one of that repository at the token's `sha`. The first call records the run and moves the prebuild to Building. The answer holds the prebuild id, the tenant id, a presigned GET of the root filesystem tar and the image digest, so the caller workflow carries none of them.
- The token is checked before anything about the tenant is read. A missing tenant or prebuild, or another repository, answers the same 404.
- A Dispatched or Building prebuild takes an upload once a run took it. An upload start from that run moves a Dispatched prebuild to Building.
- `start` takes `{tenantId, layerDigest, layerSizeBytes}`, records them, and answers `{sha256, url, uploadExpiresAt}`: one PUT to `<tenantId>/prebuilds/<prebuildId>/layers/<digest>`, signed with `content-length` and `x-amz-checksum-sha256` only. The layer cap is 5 GiB. A repeat `start` with the same digest and size answers a fresh grant, and one with another digest or size is refused Conflict. `complete` takes `{tenantId}`, finds the recorded key in the bucket and moves the prebuild to Converting.
- On GitHub, the build job runs the repository's code and holds no `id-token` permission. The upload job holds `id-token: write` and uploads the build job's `layer.tar`. It runs `prebuild.mjs` and Node.js from the root filesystem tar, never from the build job's artifact (NFR-2).

### Build script

Each base image carries the build script at `/opt/tumpel/prebuild.mjs`, so the base digest pins it.

`prebuild.mjs build <out dir>` runs with a git checkout of the repository at `/root/workspace`, which must be a real directory. Before the lifecycle commands run, it replaces `.git/config` with the core settings and an origin URL without user info. Right before the commands run, it scans the image's files as a baseline. It runs `onCreateCommand`, `updateContentCommand` and `postCreateCommand` with exactly the environment that `guest.json` names, plus `containerEnv`. On timeout it kills the whole process group. It writes `layer.tar` and `layer.json` to the out directory, and a layer over 5 GiB fails `LayerTooLarge`.

`prebuild.mjs upload <out dir> <api origin> <tenant id> <prebuild id>` takes the job's OIDC token from `TUMPEL_JOB_TOKEN` when the orb sets it, and otherwise asks `ACTIONS_ID_TOKEN_REQUEST_URL` for it with the API origin as `aud`. It exchanges the token, PUTs the layer and calls `complete`.

### Release

The release stores the base image's root filesystem tar in the private releases bucket, under `bases/<arch>/rootfs/<sha256>`. The tar holds no harness and no guest agent. That sha256 is `diff_ids[0]` of the OCI config that `ociDigest` names. A build job loads the tar with `docker import`. The control plane refuses a manifest without `clis`, so prod's `current.json` must be published again before the control plane deploys to prod.

### Connections

`ConnectionKind` is GitHub, GitHubActions, CircleCI or Namespace. GitHub Actions connects on the path `/v1/github-actions-connection` or with `tumpel github-actions`. Its link answers `reusableWorkflow` and `callerWorkflowExample`, read from `tumpel/workflows`. CircleCI connects on `/v1/circleci-connection` or with `tumpel circleci`. Namespace connects on `/v1/namespace-connection` or with `tumpel namespace`. Each tenant holds one connection per provider. The GitHub Actions connection names the caller workflow, which the job token must name. The Namespace connection holds the issuer, the `sub` and the audience that the tenant registers at Namespace.

## FAQ

**Why not run prebuilds on Tumpel's own hardware?** The tenant's provider bills the tenant, and the tenant's hosts already take the third adapter shape.

**What can a prebuild read?** The repository, and the upload URLs for its own layer.

**Why GitHub first?** GitHub is where the tenant's repositories and the App already are.

**Why CircleCI in phase 1 and not Namespace?** CircleCI works without any registration at the provider. Namespace waits about a week for its support team to register the issuer.

**Why does a CircleCI tenant still commit a config file?** CircleCI runs a pipeline only from a config file, and the file must declare every parameter the trigger passes.

**Can I self-host the issuer?** Yes. A self-hosted control plane serves its own issuer.

## Appendix of providers

Every provider fact below was checked against the provider's own documentation on 2026-11-15.

| Order  | Provider            | Shape                      | Starts a build with                                                              | Job identity                                                 | Free allowance                                                                          |
| ------ | ------------------- | -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1      | GitHub Actions      | CI dispatch                | `workflow_dispatch` through the App installation token                           | GitHub's OIDC token                                          | Not checked                                                                             |
| 1      | CircleCI            | CI dispatch                | The recommended pipeline run API, with a personal API token                      | A per-job token from the organization's issuer, custom `aud` | 30,000 credits a month, up to 6,000 build minutes                                       |
| Parked | Namespace           | Remote BuildKit            | The recipe in the request                                                        | Tumpel's OIDC token, audience `federation.namespaceapis.com` | No included minutes; Docker builds at USD 0.05 each on the Developer plan; 30-day trial |
| 3      | GitLab CI           | CI dispatch                | The pipeline trigger API; the connection is a GitLab OAuth application           | `id_tokens` with a per-token `aud`, on the Free tier         | 400 compute minutes a month                                                             |
| 4      | Bitbucket Pipelines | CI dispatch                | An on-demand pipeline, with the YAML in the request body, scope `pipeline:write` | `BITBUCKET_STEP_OIDC_TOKEN`                                  | 50 build minutes; the pricing page does not say per month                               |
| 5      | Ubicloud            | Runner for GitHub dispatch | The reusable workflow's runner label                                             | GitHub's OIDC token                                          | USD 2.50 a month, 1,250 runner minutes                                                  |

Ubicloud's API takes personal access tokens only, so any later direct use goes through the secret-set fallback. Depot is out for now: it has no free plan, only a 7-day trial. Ona is out: it competes with Tumpel, and its acquisition by OpenAI closed on 2026-08-10.

## Appendix of the CircleCI adapter

### Connection

A tenant connects CircleCI through CircleCI's OAuth flow with PKCE and Dynamic Client Registration, which issues a personal API token that lasts 90 days with no refresh token ([ADR 006](../adr/006-circleci-oauth-loopback.md)). The flow redirects only to a loopback address: `tumpel circleci authorize` listens there, and the dashboard takes back the address the browser lands on. The control plane reads the organizations the token reads; a renewal keeps the connected one, and a first connect to a token that reads several asks which one bills the builds. It seals the token like a secret set value and never answers it. A pasted personal API token is the fallback: `tumpel circleci start` reads it from `--token-stdin`, the dashboard takes it in a password field, and the control plane checks it with `GET /api/v2/me`. CircleCI's API v2 refuses project tokens. A start with an expired or revoked token is refused DispatchRefused, with the fix to connect again.

The CircleCI API maps no GitHub repository to a project of a GitHub App organization. So the tenant binds each repository once, with `tumpel circleci project add --repository <url> --project-slug <slug> --pipeline-definition-id <uuid>`. The slug is `gh/<owner>/<name>` in a GitHub OAuth organization and `circleci/<org id>/<project id>` in a GitHub App organization. The binding reads the project id and the pipeline definition. It refuses a definition that checks out another repository. Each binding registers an outbound webhook for `workflow-completed` on its project, with a signing secret the control plane generates and seals. Deleting the binding deletes the webhook.

### Dispatch

The adapter calls `POST /api/v2/project/<slug>/pipeline/run` with the binding's `definition_id`, and with `config` and `checkout` on the default branch. It passes these pipeline parameters:

| Parameter             | Value                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `tumpel_prebuild_id`  | The prebuild the start recorded                                                                   |
| `tumpel_tenant_id`    | The tenant that started it                                                                        |
| `tumpel_api_origin`   | The API origin the upload job calls and names as the token's `aud`                                |
| `tumpel_rootfs_url`   | A presigned GET of the base image's root filesystem tar, valid for the dispatch and build budgets |
| `tumpel_image_digest` | The digest of the base image the layer is built on                                                |

CircleCI caps a parameter value at 512 characters. The adapter refuses a start whose presigned URL is longer, before it triggers anything. A 201 answer carries the pipeline id. The prebuild records it in `prebuild_pipelines` and moves to Building, because CircleCI sends no event when a pipeline starts. A 200 answer created no pipeline, and the start is refused DispatchRefused with CircleCI's message. An answer in state `errored` is refused the same way.

### Events

CircleCI posts each `workflow-completed` event to `/v1/circleci-events/{tenantId}`. The handler checks the `v1` signature of the `circleci-signature` header, an HMAC-SHA256 of the body, against the secret of the binding the payload's project names. It ignores a pipeline that no prebuild recorded.

| Event                                                              | Prebuild                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `workflow-completed` of workflow `tumpel-prebuild` without success | Failed in phase Build, with the workflow's `url` as the log |
| `workflow-completed` with success and no completed upload          | Failed in phase Upload                                      |

A config that fails to compile runs no workflow and sends no event. That prebuild fails in phase Build when the build budget runs out.

### Job token

The orb's upload job mints its token with `circleci run oidc get --aud <api origin>`, which issues a V2 token. The exchange checks it in this order:

1. `iss` matches `https://oidc.circleci.com/org/<uuid>`, and the token verifies against that issuer's `/.well-known/jwks-pub.json`. This check runs before any tenant lookup.
2. `iss` names the connection's organization, and `oidc.circleci.com/vcs-origin` is `github.com/<owner>/<name>` of the prebuild's repository. Either mismatch answers the same 404 as another repository does on GitHub.
3. `oidc.circleci.com/project-id` is the binding's project, `oidc.circleci.com/pipeline-id` is the recorded pipeline. The ref claim `oidc.circleci.com/vcs-ref` is `refs/heads/<default branch>`.
4. `oidc.circleci.com/ssh-rerun` is false. A rerun with SSH hands a person a shell in the job.
5. The first upload start records `oidc.circleci.com/job-id`. Every later start and `complete` must name the same job.
6. The first upload start reads `GET /api/v2/pipeline/<id>` with the tenant's token. A `vcs.revision` other than the commit the start read fails the prebuild in phase Dispatch.

The token carries no commit, so rule 6 takes it from CircleCI's API.

### The orb

`tumpel/prebuild` defines two jobs on a Linux machine executor, which runs Docker:

- `build` imports the root filesystem tar, checks the repository out, runs `prebuild.mjs build` in a container and persists the out directory to the workspace. The container gets the same environment as on GitHub.
- `upload` runs no checkout and no repository code. It takes the upload script and its runtime from the guest image's tar. It attaches the workspace, mints the token and runs `prebuild.mjs upload` with `TUMPEL_JOB_TOKEN` set.

CircleCI sets its tokens in every job, so the build job holds one as well. Rules 3 and 5 bind any token of the pipeline to this one prebuild. A build that mints a token can upload only the layer it already writes.

A GitHub App organization lets a pipeline definition name any config path. The tenant commits this file, such as `.circleci/tumpel-prebuild.yml`, and gives its definition no trigger:

```yaml
version: 2.1
orbs:
  tumpel: tumpel/prebuild@1
parameters:
  tumpel_prebuild_id: { type: string, default: "" }
  tumpel_tenant_id: { type: string, default: "" }
  tumpel_api_origin: { type: string, default: "" }
  tumpel_rootfs_url: { type: string, default: "" }
  tumpel_image_digest: { type: string, default: "" }
workflows:
  tumpel-prebuild:
    jobs:
      - tumpel/build:
          rootfs-url: << pipeline.parameters.tumpel_rootfs_url >>
          image-digest: << pipeline.parameters.tumpel_image_digest >>
      - tumpel/upload:
          requires: [tumpel/build]
          prebuild-id: << pipeline.parameters.tumpel_prebuild_id >>
          tenant-id: << pipeline.parameters.tumpel_tenant_id >>
          api-origin: << pipeline.parameters.tumpel_api_origin >>
          rootfs-url: << pipeline.parameters.tumpel_rootfs_url >>
```

A GitHub OAuth organization reads config only from the repository's `.circleci/config.yml`. The tenant adds the same lines there, with `when: << pipeline.parameters.tumpel_prebuild_id >>` on the workflow, so a push skips it.

### Publishing

The orb's source lives in this repository at `orbs/prebuild/orb.yml`. A release step publishes it one way, as it publishes the workflow. CircleCI sets these rules:

- A CircleCI organization claims one namespace, and only an owner of that organization can claim it. Changing a claimed namespace takes CircleCI support. The CircleCI organization of the GitHub organization `tumpel` claims `tumpel`. The registry listed `tumpel` as unclaimed on 2026-11-15.
- A production version follows semver and is immutable. Only an owner of the namespace's organization publishes one. A config that imports `@1` receives every minor and patch release of major version 1.
- A development version `dev:<label>` is mutable and expires after 90 days. Any member of the organization can publish one, once a first production version exists.
- CircleCI releases every public registry orb under the MIT license.

## Appendix of terms

| Term                | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| Prebuild            | A repository's built environment, stored as one lower layer             |
| Input digest        | One digest over a repository's devcontainer files and lockfiles         |
| Build provider      | A service that runs a prebuild and bills the tenant                     |
| BuildProvider       | The port each provider adapter implements                               |
| Issuer              | The stage's OIDC token signer at `id.<stage>.tumpel.dev`                |
| Federation          | A cloud account trusting the issuer's tokens instead of a stored key    |
| Orb                 | A versioned package of CircleCI config that a pipeline imports          |
| Pipeline definition | A CircleCI project's pairing of a config file and a checkout repository |

## Appendix of entities

```tsp
model Prebuild {
  @key prebuildId: EntityId;
  tenantId: EntityId;
  repository: RepositoryUrl;
  inputDigest: Sha256Digest;
  provider: BuildProvider;
  storageKey: StorageKey;
  state: PrebuildState;
  createdAt: int64;
  updatedAt: int64;
}

enum BuildProvider {
  GitHubActions: "GitHubActions",
  CircleCI: "CircleCI",
  Namespace: "Namespace",
}

enum PrebuildState {
  Dispatched: "Dispatched",
  Building: "Building",
  Converting: "Converting",
  Done: "Done",
  Failed: "Failed",
}
```
