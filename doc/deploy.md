# Deploy

A release deploys the `dev` stage with two Cloudflare Workers Builds projects, both building the branch `release` and both declared in `cloudflare-builds-bootstrap` (`infra/projects.auto.tfvars.json`). Neither GitHub nor the self-hosted runner holds a Cloudflare secret.

- Infrastructure: the project `tumpel-infra` builds the Worker `tumpel-infra-dev` (`packages/infra-worker`, which answers 204 and nothing else). Its build command `npm run deploy:infra` downloads OpenTofu 1.13.2, checks it against the release's SHA256 sums, applies `packages/control-plane/infra/`, puts the tofu output `worker_secrets` on the control plane Worker with `wrangler secret bulk` (secrets persist across `wrangler deploy`), and writes the outputs the code deploy needs, one JSON object without secrets, to `infra-outputs-<stage>.json` in the private R2 bucket `tumpel-builder-secrets`. The object also records `infra_fingerprint`, a SHA-256 over the sorted relative paths and contents of the files in `packages/control-plane/infra` it was applied from, leaving out `.terraform` and state files. Its deploy command `npx wrangler deploy --config packages/infra-worker/wrangler.jsonc` deploys the Worker. Its build watch paths are `packages/control-plane/infra/*` and `packages/infra-worker/*`, so a release that changes neither skips it.
- Code: the project `tumpel` builds the Worker `tumpel-control-plane-dev` on every push to `release`. Its deploy command `npm run deploy:code` reads `infra-outputs-<stage>.json`, builds and deploys the dashboard, applies D1 migrations, upserts the dashboard's OAuth client, deploys the control plane with `ACCESS_ISSUER`, `ACCESS_AUD`, `ACCESS_PROOF_COMMON_NAME`, `ISSUER_HOSTNAME`, `DASHBOARD_ORIGIN` and `API_ORIGIN` from that object.

Both projects carry the plain build variables `NODE_VERSION`, `TUMPEL_STAGE` and `TUMPEL_ACCOUNT_ID`, and the encrypted build variable `CLOUDFLARE_TOFU_TOKEN` (the `tumpel-tofu` token): the code deploy runs wrangler with it, because the token Workers Builds generates holds no D1 permission. `tumpel-infra` also carries the encrypted `TFSTATE_ACCESS_KEY_ID`, `TFSTATE_SECRET_ACCESS_KEY`, `TUMPEL_APPROVER_EMAILS` and `TUMPEL_BOOTSTRAP_API_TOKEN`. `cloudflare-builds-bootstrap` copies each encrypted value in process from the objects `tofu-bootstrap` wrote to `tumpel-builder-secrets`, so nobody pastes one. The deploys need Node and OpenTofu but not cargo, so the builds install the npm workspaces only.

To release, push a tag `v*` on a commit of `main`. `release.yml` publishes it and its job `promote` fast-forwards `release` to the tag, which starts the code build, and the infra build when the release changes an infra path. The code build stops with "infra build for this release has not finished; retry" when the object's `infra_fingerprint` differs from the one its own checkout computes, so it never deploys against the outputs of another infra; retry it once the infra build succeeds (Workers & Pages, `tumpel-control-plane-dev`, Deployments, Retry build). On a new stage the control plane Worker does not exist during the first infra build, so retry the infra build after the first code build to add its secrets and custom domains. To force an infra run without an infra change, retry the latest `tumpel-infra-dev` build the same way, or let `promote` push a release whose commits touch `packages/infra-worker`. After every deploy of a stage, `npm run proof:e2e` runs the seventeen-step proof of EDD-006 against that stage (`doc/EDD/006-end-to-end-proof.md`), on the host that `TUMPEL_PROOF_HOST` names. Do not deploy from a checkout; the commands below are for bootstrapping an account or a new stage.

The control plane deploys per stage; the stage is `TUMPEL_STAGE` and defaults to `dev`. Every stage serves under the zone `tumpel.dev`, declared in `packages/control-plane/infra/domains.tf`. The control plane Worker answers on the custom domain `api.<stage>.tumpel.dev` (API, MCP, browser pages and releases). It also serves the issuer on the custom domain `id.<stage>.tumpel.dev`. The Worker `tumpel-dashboard-<stage>` serves the dashboard (`packages/dashboard`, static assets behind a Worker) on the custom domain `<stage>.tumpel.dev`, and it answers `app.<stage>.tumpel.dev` with a 308 to the dashboard. Stage `prod` drops the stage label: `api.tumpel.dev`, `id.tumpel.dev`, and the dashboard on the apex `tumpel.dev`. The issuer name never moves once tenants pin it, so its custom domain refuses to be destroyed. Stage `dev` serves the API on `api.dev.tumpel.dev` and its dashboard on `dev.tumpel.dev`. The dev GitHub App is https://github.com/apps/tumpel-dev, owned by the organization https://github.com/tumpel. Zone resources go through the provider alias `bootstrap`, because `tumpel-tofu` holds no zone permission. Each custom domain brings its own certificate; the zone certificate covers one label under `tumpel.dev` only, so a proxied record at `<name>.<stage>.tumpel.dev` serves no TLS. A custom domain needs the Worker to exist, so the first deploy of a stage applies the infra without it, deploys the Worker, and applies again. Neither Worker serves a workers.dev host (`workers_dev` is false in both `wrangler.jsonc` files).

A stage is a wrangler environment of the same name in `packages/control-plane/wrangler.jsonc`, plus one OpenTofu state, `tumpel-<stage>.tfstate` in `tumpel-tfstate`. Each environment repeats the bindings, vars and Durable Object migrations, because wrangler does not inherit them. Account-wide resources carry the stage in their names: `tumpel-control-plane-<stage>`, `tumpel-sessions-<stage>`, `tumpel browser pages <stage>` and its policy. The D1 database is named `tumpel-<stage>` when a stage creates it; `dev` adopted the original database, still named `tumpel`, and OpenTofu ignores later name changes. To add a stage, add its `env` block, run `TUMPEL_STAGE=<stage> npm run deploy:infra`, copy the printed `database_id` into that block, and deploy.

The account token is `tumpel-tofu`. It carries Access: Apps and Policies Write, Access: Policies Write, Access: Organizations, Identity Providers, and Groups Read, Account Settings Read, D1 Write, Workers Scripts Write and Workers R2 Storage Write. To add a permission group, PUT the token by id with the group appended, using the token-minting key; the token value stays the same. OpenTofu keeps its state in the R2 bucket `tumpel-tfstate`, reached with the `tumpel-tfstate` token as S3 keys. Both are stored in dotfiles as `tumpel-tofu-token` and `tumpel-tfstate-s3`. `~/.config/tumpel/cf-env` (mode 600) holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TFSTATE_ACCESS_KEY_ID`, `TFSTATE_SECRET_ACCESS_KEY` and `TUMPEL_APPROVER_EMAILS` (a JSON list).

`tofu-bootstrap tumpel --secrets <file> --debug-token-exists` writes the bucket `tumpel-builder-secrets` once, with `CLOUDFLARE_TOFU_TOKEN`, both `TFSTATE_*` keys and `deploy.secrets.json` (the token-minting key `TUMPEL_BOOTSTRAP_API_TOKEN`, and `TUMPEL_APPROVER_EMAILS`). `cloudflare-builds-bootstrap` sets the encrypted build variables from these objects; after a rotation, copy them again from that repository with `tofu apply -replace='terraform_data.trigger["<label>"]'`, once for `tumpel` and once for `tumpel-infra`. Off Workers Builds, a deploy reads `cf-env`, takes the bootstrap key from `TUMPEL_BOOTSTRAP_API_TOKEN` when set, and otherwise decrypts it from dotfiles.

Bootstrap order on a new account:

1. Mint `tumpel-tofu` and `tumpel-tfstate` with the token-minting key, create `tumpel-tfstate`, and write `cf-env`.
2. `npm run deploy:infra` applies `packages/control-plane/infra/`: the D1 database `tumpel`, the R2 bucket `tumpel-sessions-<stage>` (transcript chunks and snapshots), and the Access application `tumpel browser pages <stage>`, which puts `/device`, `/v1/tenants`, `/v1/device/approve`, `/v1/device/deny`, `/oauth/consent`, `/invitations/accept`, `/v1/invitations/accept` and the three `/github/app/` pages behind the one-time PIN.
3. Copy the `database_id` it prints into the stage's `env` block of `wrangler.jsonc` and commit.
4. Presigned snapshot URLs need an R2 API token with Object Read & Write on `tumpel-sessions-<stage>` only. OpenTofu manages it as `tumpel-r2-<stage>` in `infra/tokens.tf`. The `bootstrap` provider alias mints it with the account's token-minting key `reader-cloudflare-tofu-token`. Cloudflare refuses Account API Tokens Write on a token that another token minted, so `tumpel-tofu` cannot hold that permission. `npm run deploy` decrypts the key in process from dotfiles and passes it as `TF_VAR_bootstrap_api_token`. The output `worker_secrets` derives the S3 key pair from the token (access key id is the token id, secret is the SHA-256 hex of the token value) and `npm run deploy` puts `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` on the Worker after deploying it. The Worker signs short-lived snapshot upload and download URLs with it; hosts never hold a storage key.
5. After the first deploy, open `/github/app/setup` on the stage in a browser and register the stage's GitHub App. Every self-hosted control plane registers its own App, one per stage. Add `?organization=<login>` to register it under an organization. GitHub returns to `/github/app/created`, and the page refuses once an App exists. The install callback connects an organization only for the GitHub account that installed the App, which it learns from the `sender` of the `installation` webhook; the App needs no organization permission for that.

The Worker reads its turn budgets, snapshot delay and deadline, dispatch grant lifetime and transcript chunk size from the `TUMPEL_SETTINGS` var in `wrangler.jsonc`, checked against `ControlPlaneSettings` in `packages/api/models.tsp`.

Commands, for bootstrap only:

- `npm run deploy` runs `npm run deploy:infra`, then `npm run deploy:code`. `npm run deploy:infra` applies the stage's infra, refuses a plan that destroys anything but the retired `app` record and route and the retired `id` record, sets the Worker secrets once the control plane Worker exists, and writes `infra-outputs-<stage>.json`. `npm run deploy:code` builds the dashboard against `https://api.<stage>.tumpel.dev` and deploys it as `tumpel-dashboard-<stage>` without the Workers Builds name override. It then applies D1 migrations, and deploys the control plane Worker with the vars from `infra-outputs-<stage>.json`. The control plane deploys last, so a failed dashboard deploy never replaces the API. A first deploy of either Worker applies the infra without its custom domain; `npm run deploy` applies again once the Worker exists and then sets the secrets, and on Workers Builds the next infra build adds it.
- `npm run deploy:migrate` applies D1 migrations only.
- `npm run proof:e2e` validates a stage after its deploy: it runs the seventeen steps of EDD-006 against the stage's Worker and the host `TUMPEL_PROOF_HOST` (default `tumpel-host`), and loads the subscription token and its expiry in process from the host Claude Code credential `~/.claude/.credentials.json` (`TUMPEL_PROOF_CREDENTIAL` unset or `claude-credentials[:<path>]`), or from `TUMPEL_PROOF_CREDENTIAL=dotfiles:<key name>` together with `TUMPEL_PROOF_CREDENTIAL_EXPIRES_AT=<ISO 8601 date-time with offset>`.
- `npm run proof -- <command>` runs a command with `TUMPEL_PROOF_CLIENT_ID` and `TUMPEL_PROOF_CLIENT_SECRET` read from the stage's tofu outputs. It prints neither value. A command named `tumpel` runs the release CLI.
- `npm run proof` and `npm run proof:e2e` download the current release's CLI for this machine and its Amd64 supervisor into `.tmp/proof-release/`, and check each against the sha256 that `current.json` names. `TUMPEL_PROOF_CLI` and `TUMPEL_PROOF_SUPERVISOR` replace them with local builds (`npm run cli:build`, `npm run supervisor:build`).

Install the CLI on a Linux machine with `curl -fsSL https://api.dev.tumpel.dev/v1/releases/install.sh | sh`, then sign the terminal in with `tumpel login --endpoint https://api.dev.tumpel.dev`. The Account page of the dashboard shows the same command for its stage.

Connect claude.ai in Settings, Connectors, Add custom connector. Enter the stage's origin followed by `/mcp`, and leave the client id and secret empty. Choose Connect and sign in through Access, with an email that is an approver and owns a tenant.

The end-to-end proof signs in without a person: `infra/proof.tf` mints the Access service token `tumpel-proof-<stage>` with the `bootstrap` alias and lets it through the Access application with a `non_identity` policy. `npm run deploy` sets its client id as the Worker var `ACCESS_PROOF_COMMON_NAME`. The Worker accepts that service token on `/v1/device/approve`, `/oauth/consent` and `/v1/device/deny` only, as the owner of the tenant `Tumpel proof`. That tenant's id and principal id derive from the client id, and the Worker creates both on first use. `npm run proof -- tumpel login --endpoint <stage url>` approves its own code with it.

## GitHub App permissions

The manifest in `packages/control-plane/src/github.ts` asks for every permission an agent needs to run a repository: code, CI, settings, issues and releases. A turn's token covers only the turn's repository. Organization-wide powers and the installer's own account stay out.

| Permission (manifest key)                          | Level | Reason                                                              |
| -------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| Actions (`actions`)                                | write | Dispatch prebuilds, rerun and cancel workflow runs.                 |
| Administration (`administration`)                  | write | Branch protection, rulesets, repository settings and collaborators. |
| Artifact metadata (`artifact_metadata`)            | write | Record build artifact metadata from CI.                             |
| Attestations (`attestations`)                      | write | Create and read build provenance attestations.                      |
| Checks (`checks`)                                  | write | Report and rerun check runs.                                        |
| Code quality (`code_quality`)                      | read  | Read code quality findings to fix them.                             |
| Code scanning alerts (`security_events`)           | write | Upload SARIF and triage code scanning alerts.                       |
| Commit statuses (`statuses`)                       | write | Set commit statuses.                                                |
| Contents (`contents`)                              | write | Clone, push, branches, tags and releases.                           |
| Custom properties (`repository_custom_properties`) | write | Set the repository's custom property values.                        |
| Dependabot alerts (`vulnerability_alerts`)         | write | Triage and dismiss Dependabot alerts.                               |
| Dependabot secrets (`dependabot_secrets`)          | write | Set the secrets Dependabot updates use.                             |
| Deployments (`deployments`)                        | write | Create deployments and their statuses.                              |
| Discussions (`discussions`)                        | write | Read and answer discussions.                                        |
| Environments (`environments`)                      | write | Configure deployment environments, their secrets and variables.     |
| Issues (`issues`)                                  | write | Work, label, comment on and close issues.                           |
| Merge queues (`merge_queues`)                      | write | Manage the merge queue.                                             |
| Metadata (`metadata`)                              | read  | Required by GitHub for every App.                                   |
| Packages (`packages`)                              | write | Publish and read the repository's packages.                         |
| Pages (`pages`)                                    | write | Configure and build GitHub Pages.                                   |
| Projects (`repository_projects`)                   | write | Manage the repository's projects.                                   |
| Pull requests (`pull_requests`)                    | write | Open, review, comment on and merge pull requests.                   |
| Secret scanning alerts (`secret_scanning_alerts`)  | write | Triage and resolve secret scanning alerts.                          |
| Secrets (`secrets`)                                | write | Set Actions secrets for CI; values are never readable.              |
| Variables (`actions_variables`)                    | write | Set Actions variables for CI.                                       |
| Webhooks (`repository_hooks`)                      | write | Configure the repository's webhooks for integrations.               |
| Workflows (`workflows`)                            | write | Push changes to `.github/workflows`.                                |
| Organization: Members (`members`)                  | read  | Read teams and members to request team reviews and assign issues.   |
| Organization: Projects (`organization_projects`)   | write | Move issues and pull requests on organization project boards.       |

Left out:

- Organization administration, secrets, variables, Dependabot secrets, private registries, webhooks, self-hosted runners, hosted runner images and network configurations: organization-wide control beyond the installed repositories.
- Organization personal access tokens and their requests, blocking users, custom roles, custom properties, external custom properties, issue fields and issue types, campaigns, events and API insights: governance of the organization and its people.
- GitHub Copilot Business, Copilot metrics, Copilot agent settings, Copilot Spaces, Copilot content exclusion and the organization codespaces permissions: billing and seats.
- Repository creation and GitHub App installation repository access: they create repositories or widen the installation beyond what the installer chose.
- Codespaces, Codespaces lifecycle admin, metadata and secrets: billed to the owner, and the box replaces them.
- Repository security advisories: publishing an advisory is a disclosure decision for a maintainer.
- Agent secrets, agent variables and Copilot agent settings on the repository: they configure GitHub's own agents.
- Single file: Contents covers it.
- Every account permission: the App acts on repositories, never on the installer's own account.
- Every enterprise permission.

Administration write also lets a token delete, archive, transfer or change the visibility of its repository; GitHub offers no narrower permission for branch protection and rulesets. Each token covers one repository, and an organization owner restores a deleted repository within 90 days.

The App subscribes to `workflow_run`, which completes a GitHub Actions prebuild, and receives `installation` without subscribing; no other event has a handler.

### Updating the dev App

A changed manifest does not update an App that exists. For tumpel-dev, open https://github.com/organizations/tumpel/settings/apps/tumpel-dev/permissions and set, top to bottom:

Repository permissions:

1. Actions: Read and write
2. Administration: Read and write
3. Artifact metadata: Read and write
4. Attestations: Read and write
5. Checks: Read and write
6. Code quality: Read-only
7. Code scanning alerts: Read and write
8. Commit statuses: Read and write
9. Contents: Read and write
10. Custom properties: Read and write
11. Dependabot alerts: Read and write
12. Dependabot secrets: Read and write
13. Deployments: Read and write
14. Discussions: Read and write
15. Environments: Read and write
16. Issues: Read and write
17. Merge queues: Read and write
18. Metadata: Read-only
19. Packages: Read and write
20. Pages: Read and write
21. Projects: Read and write
22. Pull requests: Read and write
23. Secret scanning alerts: Read and write
24. Secrets: Read and write
25. Variables: Read and write
26. Webhooks: Read and write
27. Workflows: Read and write

Organization permissions:

28. Members: Read-only
29. Projects: Read and write

Leave every other permission at No access, and leave the events as they are. Choose Save changes. An owner of each installation then accepts once: on `https://github.com/organizations/<org>/settings/installations/<installationId>` for an organization, or `https://github.com/settings/installations/<installationId>` for a personal account, choose Review request, then Accept new permissions.

## Releases

Two workflows publish to the R2 bucket `tumpel-releases-<stage>`, which is `dev` unless a manual run names another stage. Both build amd64 only. The workflow-level flag `BUILD_ARM64` gates the arm64 build and stays `false`: nothing claims arm64 host support until a real arm64 host passes the proof (`doc/test-host.md`). `npm run guest:image` and `npm run release:publish` read the same flag from the environment and refuse arm64 while it is off. The image build runs on the runner that the repository variable `BUILD_RUNNER` names, and on `ubuntu-24.04` when the variable is unset (`doc/test-host.md`); everything else runs on `ubuntu-24.04`. `checks.yml` runs `npm run check`, the npm tests in three shards (`TEST_SHARD`) and `cargo test` on `ubuntu-24.04`, in parallel with the build, and gates every publish.

`.github/workflows/release.yml` runs on every push to `main` and every push of a tag `v*`, so the checks run on every commit and `current.json` names the commit Workers Builds deployed; unchanged binaries upload nothing, since every object is stored by digest. It builds the supervisor and the CLI in one cargo invocation (`npm run release:build`), uploads both, and once the checks pass writes `current.json` with the images of the latest image release, read from `images.json`. It is the only writer of `current.json`. It refuses to publish when the guest protocol of `images.json` differs from the commit's `GuestProtocol.Version`: push an image release tag on that commit first. A run whose commit is an ancestor of the commit `current.json` already holds leaves it alone, so a slow run never moves the release backwards; on a tag that fails the run. A tag run publishes to `dev` like a push to `main`, with the tag as `releaseVersion`. A push to `main` publishes the supervisor and the CLI but deploys nothing. A tag `v*` releases: once the checks pass and `current.json` is written, the job `promote` fast-forwards the branch `release` to the tag, and Workers Builds deploys the Workers from that branch, so the control plane never requires a protocol that no published supervisor speaks. Workers Builds builds no other branch. A push to `release` that is not a fast-forward fails the job. A newer push never cancels a running release; it queues behind it.

`.github/workflows/images.yml` builds and uploads the guest images only on a push of a tag `images-vX.Y.Z` (an image release). Once the checks pass it writes `images.json`, an `ImageRelease` (`packages/api/release.tsp`) naming the tag, its commit, its guest protocol version and the images. The images go live when `release.yml` next publishes; run it on `main` by hand (Actions, release, Run workflow) to carry them over at once. Tag a new image release after a change to the guest (`crates/tumpel-guest`), the harness catalog, `npm-scripts/guest-image.mjs` or `npm-scripts/prebuild.mjs`: commits to `main` never rebuild images, so hosts download nothing new until the next image release. A release from `main` fails while the bucket holds no `images.json`.

Every object in the bucket is stored once under its digest and never changes:

- `supervisor/<arch>/<sha256>` holds a supervisor binary.
- `cli/<arch>/<sha256>` holds a CLI binary.
- `images/<harness>/<version>/<arch>/<digest>` holds an ext4 image or its manifest.
- `kernels/<arch>/<sha256>` holds a kernel.

Two objects change. `images.json` is the latest image release. `current.json` is the current release as a `ReleaseManifest` (`packages/api/release.tsp`). It holds `releaseVersion`, `commit`, `channelProtocolVersion`, `supervisors` and `clis` (each `architecture`, `sha256`, `sizeBytes`) and `images` (`harness`, `harnessVersion`, `architecture`, `imageDigest`, `kernelDigest`, `manifestDigest`, `ociDigest`, `rootfsDigest`). The control plane refuses a manifest whose `channelProtocolVersion` differs from the channel protocol.

The control plane serves `GET /v1/releases/current` without sign-in. `GET /v1/releases/supervisor/{architecture}` and `GET /v1/releases/cli/{architecture}` answer 302 to a presigned URL that lives 5 minutes, so a fresh host needs only `curl -fL <origin>/v1/releases/supervisor/Amd64`. `GET /v1/releases/install.sh` serves `packages/control-plane/src/install.sh` without sign-in, with the origin filled in: it picks the architecture, downloads the CLI through `/v1/releases/cli/{architecture}`, checks it against the sha256 in `current.json`, and installs it to `~/.local/bin/tumpel`, or to the folder `TUMPEL_INSTALL_DIR` names. Hosts on `dev` boot only images that a published release carries. A turn whose release lacks the session's image fails ImageNotReleased. `tumpel harness pin` refuses a version that the release carries for none of the tenant's host architectures.

The token `tumpel-releases-upload-<stage>` writes the bucket. `npm run release:secrets` sets the workflow's secrets `CLOUDFLARE_ACCOUNT_ID`, `R2_RELEASES_SECRET_ACCESS_KEY` and `R2_RELEASES_ACCESS_KEY_ID` from the tofu outputs. It prints none of them.

## GitHub Actions prebuilds

Caller workflows call `tumpel/workflows/.github/workflows/prebuild.yml@v1` in the public repository [tumpel/workflows](https://github.com/tumpel/workflows), which is maintained there directly (`doc/github-actions-prebuild.md`); nothing in this repository publishes to it. Its tag ruleset `release tags are immutable` keeps `v*.*.*` tags from moving or being deleted, and `v1` stays outside it.

A person sets up step 16 of the proof once per stage:

1. Create the fixture repository. Its default branch holds the caller workflow of `doc/github-actions-prebuild.md` at `.github/workflows/tumpel-prebuild.yml`, and a `.devcontainer/devcontainer.json` or a root lockfile.
2. Grant the dev App write on actions, and accept the new permission on the proof tenant's installation, which must cover the fixture repository.
3. Set `TUMPEL_PROOF_PREBUILD_REPO` to the fixture's URL, such as `https://github.com/<owner>/<name>`.

The dev stage's fixture is `https://github.com/tumpel/prebuild-fixture`, so run its proof with `TUMPEL_PROOF_PREBUILD_REPO=https://github.com/tumpel/prebuild-fixture npm run proof:e2e`.

## Issuer

The issuer is the control plane Worker on `id.<stage>.tumpel.dev`, which the Worker var `ISSUER_HOSTNAME` names. There it serves `/.well-known/openid-configuration` and `/.well-known/jwks.json`, and it answers 404 to every other path. The issuer signs with one RS256 key, which the Worker generates itself at 2048 bits, and the JWKS publishes only that key. Its `kid` is its RFC 7638 thumbprint. The central table `issuer_keys` holds the private key, sealed under a data key that `SECRETS_KEK` wraps. The key never rotates; to re-key a stage, delete its row from `issuer_keys` in the central D1 database and the Worker generates a new key on the next request, after which tokens signed with the old key no longer verify. A token lives 300 s and carries `iss`, `sub`, `aud`, `iat`, `nbf`, `exp` and `jti`. Its `sub` is `tenant:<tenantId>:persona:<name>:job:prebuild`.
