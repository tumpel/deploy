# RFC: Prebuilds and build providers

| Field   | Value                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Proposed                                                                                                                                                                      |
| Author  | Matthijs van Henten                                                                                                                                                           |
| Date    | 2026-11-15                                                                                                                                                                    |
| Related | [RFC: Tumpel](RFC-TUM-Tumpel.md), [EDD-003](../EDD/003-credentials.md), [EDD-004](../EDD/004-snapshots-and-transcripts.md), [Dashboard requirements](../product/dashboard.md) |

## Summary

A prebuild installs a repository's dependencies once, ahead of any session, and stores the result. A box then starts with that work done. Tumpel runs no build on its own machines. It asks a build provider that the tenant already uses, such as GitHub Actions or Namespace, and the provider bills the tenant. Every provider hands back the same thing: a container image layer, uploaded to Tumpel's object storage on presigned URLs. Tumpel stores that layer in the same chunk and pack store as snapshots, so a box reads one format whatever built it. Tumpel also becomes an OpenID Connect issuer. A tenant's cloud account and build provider can then trust short-lived tokens that Tumpel signs, and no tenant stores a cloud key in Tumpel. This RFC adds to RFC: Tumpel and replaces none of it.

## Tenets

The tenets of [RFC: Tumpel](RFC-TUM-Tumpel.md#tenets) hold unchanged. Three of them drive this design: all primitives get wrapped, no standing secrets, and every phase has a time limit and a named failure.

## Problem statement

The guest image holds Ubuntu, git, the GitHub CLI and the harness, and none of a repository's own dependencies ([guest image](../guest-image.md)). A box clones the repository before the harness starts, so anything else the repository needs gets installed inside a turn, on the turn's 3,600 s budget. A snapshot keeps those files for its own session only. Tumpel has no way to build a repository's environment outside a box.

## Proposal

### Prebuilds

A prebuild is a job of its own. Its input is a repository plus one digest over the repository's devcontainer files and lockfiles. Its output is one content-addressed layer. The pair of repository and input digest is the prebuild's key, so every commit with the same devcontainer and lockfiles shares one layer.

At a session's first turn, the control plane reads those files through the GitHub App, computes the digest and finds the stored prebuild with that key. When one exists, the turn offer names it. The supervisor restores the layer from packs the way it restores a snapshot (EDD-004), and the box boots with three layers: the image, the prebuild layer and the session's own overlay. A session keeps the prebuild it started with. When no prebuild matches, the box boots from the image alone, as it does now.

### The output contract

Every provider uploads an OCI image layer to presigned object storage URLs that the control plane signs per prebuild. The control plane then cuts the layer into chunks with the snapshot chunker and stores them in the tenant's packs. Chunks the tenant already holds are not stored twice. Boxes only ever see packs. So a provider adapter ends at the upload, and no box code knows which provider built its layer.

### The build provider port

BuildProvider is a port with one operation: start a prebuild for a key, with upload URLs and a deadline. Each adapter reports Done or a named failure. Adapters come in three shapes:

1. CI dispatch. Tumpel triggers a pipeline in the tenant's CI, and the pipeline runs the build. GitHub Actions comes first; CircleCI, GitLab CI and Bitbucket Pipelines follow.
2. Remote BuildKit. Tumpel sends the build recipe with the request to a hosted BuildKit service. Namespace comes first; Docker Build Cloud is a later candidate.
3. Ephemeral VM by API. A machine runs the build and is thrown away. A tenant host with the builder capability is the first candidate, and it runs the build without a box. Fly Machines, Ubicloud and Hetzner are later candidates.

A prebuild needs no microVM. It runs the repository's own scripts with read access to the repository and nothing else. It never receives a provider key, a model key or a secret set value.

### Connections

Each provider joins the dashboard's Connections screen as one connection, with the states NotConfigured, NotConnected and Connected. Each adds its own `get`, `start` and `delete` operations and one row in `Connections_list`. The tenant connects its own account at each provider.

## Phases

Phase 1 builds two adapters: GitHub Actions dispatch and Namespace. The pair differs on every axis. One runs a dispatched pipeline, the other remote BuildKit. GitHub authenticates through the existing App, while Namespace trusts Tumpel's OIDC tokens. A file in the repository holds the recipe for GitHub, and Namespace takes the recipe in the request. When the port serves both, a later adapter adds plumbing and no new concept. Phase 1 also builds the issuer, which Namespace needs, and publishes the reusable workflow.

## Follow-ups

The follow-ups come in this order. Each is one spec with its own adapter, connection and proof. Every provider fact below was checked against the provider's own documentation on 2026-11-15.

| Order | Provider            | Shape                      | Starts a build with                                                              | Job identity                                                 | Free allowance                                                                          |
| ----- | ------------------- | -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1     | GitHub Actions      | CI dispatch                | `workflow_dispatch` through the App installation token                           | GitHub's OIDC token                                          | Not checked                                                                             |
| 1     | Namespace           | Remote BuildKit            | The recipe in the request                                                        | Tumpel's OIDC token, audience `federation.namespaceapis.com` | No included minutes; Docker builds at USD 0.05 each on the Developer plan; 30-day trial |
| 2     | CircleCI            | CI dispatch                | The recommended pipeline run API, with a personal or project API token           | `CIRCLE_OIDC_TOKEN_V2`, custom audience supported            | 30,000 credits a month, up to 6,000 build minutes                                       |
| 3     | GitLab CI           | CI dispatch                | The pipeline trigger API; the connection is a GitLab OAuth application           | `id_tokens` with a per-token `aud`, on the Free tier         | 400 compute minutes a month                                                             |
| 4     | Bitbucket Pipelines | CI dispatch                | An on-demand pipeline, with the YAML in the request body, scope `pipeline:write` | `BITBUCKET_STEP_OIDC_TOKEN`                                  | 50 build minutes; the pricing page does not say per month                               |
| 5     | Ubicloud            | Runner for GitHub dispatch | The reusable workflow's runner label                                             | GitHub's OIDC token                                          | USD 2.50 a month, 1,250 runner minutes                                                  |

Ubicloud's API takes personal access tokens only, so any later direct use goes through the secret-set fallback. Depot is out for now: it has no free plan, only a 7-day trial. Ona is out: it competes with Tumpel, and its acquisition by OpenAI closed on 2026-08-10.

## The OIDC issuer

Each stage serves its issuer on its own hostname: `https://id.dev.tumpel.dev` for `dev` and `https://id.tumpel.dev` for `prod`. The DNS records exist and refuse destruction, and the hostname never moves once a tenant pins it. The issuer serves two documents:

- `/.well-known/openid-configuration`, the discovery document, with `issuer`, `jwks_uri`, `response_types_supported` of `id_token`, `subject_types_supported` of `public` and signing algorithm RS256.
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

Rotation publishes the next key in the JWKS 24 h before it signs anything. The retired key stays in the JWKS for 24 h after its last token. A rotation is an operator action, and a timer on the retired key removes it.

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
- **FR-4 Connect a provider.** A tenant connects GitHub Actions or Namespace through the Connections model, and later each follow-up provider. (BR-2)
- **FR-5 Named failures.** A prebuild ends Done or Failed. Each failure names its phase: dispatch, build, upload or conversion. (BR-1)
- **FR-6 Federate.** A tenant's AWS, GCP or Azure account trusts the stage's issuer and assumes a role with a Tumpel token. (BR-3)

### Non-functional requirements

- **NFR-1 One format.** A box reads every prebuild from packs, whatever built it.
- **NFR-2 Credential-less builds.** A build holds read access to its repository and nothing else.
- **NFR-3 No cross-tenant `sub`.** No token's `sub` matches a rule written for another tenant.
- **NFR-4 Budgets.** Dispatch, build, upload and conversion each have a budget and a named failure.

## Decisions

On 2026-11-15 the following rulings were made:

> we keep github dispatch as the escape hatch. we meet the devs where they are already, and we add 2-3 alternative contenders to prove the infrastructure, those who are generous towards free build minutes and oidc/oauth.

> fine, we do two to start with, but your other recommendations get planned, so we have an easy follow up strategy I can kick off in a few stolen moments.

> tumpel will be oss.

**Tenants opt in through a reusable workflow.** Tumpel publishes the prebuild workflow in a public repository. A tenant adds a short caller workflow that triggers on `workflow_dispatch` and calls Tumpel's workflow at a pinned tag or commit. The GitHub App never commits a file into a tenant repository. The App's manifest adds write on actions, which the dispatch call requires.

**Tumpel is open source under Apache-2.0.** The repository stays private for now. Anyone can fetch the reusable workflow, the installer and the images. Self-hosting the control plane is supported next to the hosted `tumpel.dev`. Nothing proprietary or secret lives in the repository. Secrets stay in tofu and the key-store port.

### Proposed decisions

**A job gets its upload URLs by presenting its provider's OIDC token.** The options are to put presigned URLs in the dispatch inputs, or to have the job exchange its provider's OIDC token with the control plane for them. A URL in the dispatch inputs is a credential in the run's record. The recommendation is the exchange. GitHub, CircleCI, GitLab and Bitbucket each issue a job token.

**Where the BuildKit client and the conversion run is open.** Namespace needs a BuildKit client that sends it the recipe, and the uploaded layer needs cutting into chunks. The candidates are a tenant host or a machine at the provider. No recommendation exists yet.

## FAQ

**Why not run prebuilds on Tumpel's own hardware?** The tenant's provider bills the tenant, and the tenant's hosts already take the third adapter shape.

**What can a prebuild read?** The repository, and the upload URLs for its own layer.

**Why GitHub first?** GitHub is where the tenant's repositories and the App already are.

**Why Namespace in phase 1 and not CircleCI?** Namespace differs from GitHub on every axis, so the pair tests the port. CircleCI then adds plumbing.

**Can I self-host the issuer?** Yes. A self-hosted control plane serves its own issuer.

## Appendix of terms

| Term           | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| Prebuild       | A repository's built environment, stored as one lower layer          |
| Input digest   | One digest over a repository's devcontainer files and lockfiles      |
| Build provider | A service that runs a prebuild and bills the tenant                  |
| BuildProvider  | The port each provider adapter implements                            |
| Issuer         | The stage's OIDC token signer at `id.<stage>.tumpel.dev`             |
| Federation     | A cloud account trusting the issuer's tokens instead of a stored key |

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
