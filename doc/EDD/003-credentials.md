# EDD-003: Credentials

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

A persona names one secret set. Only that set's values and a GitHub App token for the session's repository reach its sessions. The control plane keeps every value encrypted under one data key per tenant, which a Worker secret wraps. When it sends a turn offer, it decrypts the set's values and puts them in the offer. In the box, the guest exports them into the harness's environment. Every handover leaves an audit record with names and no values.

## Model

`Persona.secretSetId` is a required field. Each tenant starts with a Default secret set, which its Default persona names. Each member of a set has a name and one of three kinds:

- `Variable`, a value the box gets under the member's own name, such as `GITHUB_TOKEN`, which the box clones with when no installation token replaces it (EDD-001);
- `ApiKey`, a provider's API key;
- `SubscriptionToken`, a provider's subscription token with its `expiresAt`.

A second credential for a provider the set already covers is refused with 409. The API writes values and never reads them back. The harness catalog lists the credential kinds each harness takes and the variable it reads for each. Claude Code takes an API key in `ANTHROPIC_API_KEY` or a subscription token in `CLAUDE_CODE_OAUTH_TOKEN`. Codex and OpenCode take an API key only. A start is refused with `NoCredential` when the persona's set holds no credential for the harness's provider. The control plane refuses a persona write, start or send with `CredentialKindUnsupported` when the set's credential is of a kind the harness does not take. It refuses a start or send with `CredentialExpired` when the set's subscription token is past its `expiresAt`. A delete of a secret set that a persona names is refused with 409.

## Encryption at rest

Each tenant has one data key. The control plane encrypts each value under it with AES-256-GCM, with the secret set id and the member name as associated data. The Worker secret `SECRETS_KEK` wraps every tenant data key. OpenTofu generates it, and the deploy sets it on the Worker. The control plane wraps and unwraps data keys through a key-store port, and this Worker secret is its one backend. The control plane decrypts values only when it prepares a turn offer.

Migration 0006 seals the values an older control plane stored in plain text. It renames each legacy member name to the `SecretName` pattern and drops a renamed member that collides with a name already in the set.

## Handover

On every send of a turn offer, the control plane resolves the persona to its set and decrypts every member into a grant. The harness's credential goes under the variable the catalog maps for its kind. Every other member goes under its own name. A subscription token past its `expiresAt` fails the turn `CredentialExpired` instead.

Each grant holds an id, an expiry 300 s ahead and the variables. The control plane stores the offer without the grant. Once the expiry passes, the supervisor fails the turn `DispatchCredentialExpired`. When the harness ends with an error result that names a refused credential, the turn fails `CredentialRefused`, and only that failure says how to replace the set's value. Over vsock, the supervisor passes the grant to the guest and writes nothing to disk.

For each turn, the guest writes the persona's files and exports the variables before the harness starts. When either changed since the harness started, the guest restarts the harness before the turn.

## App creation

Each stage has one GitHub App, and every self-hosted control plane registers its own. A person creates it once from GitHub's manifest flow at the browser page `/github/app/setup`, and GitHub returns to `/github/app/created`. The stage's Cloudflare Access application covers both pages and refuses the proof's service token. Adding `?organization=<login>` creates the App under that organization. Once an App exists, the page refuses.

The manifest asks for write on contents, pull requests, issues and discussions. It also asks for write on checks, statuses, workflows and actions, and for read on metadata. A GitHub Actions prebuild dispatches with the actions write permission. A changed manifest does not update an existing App, so the App's owner adds the permission in its settings and each installation accepts it. It leaves out the administration, members, organization and secrets permissions. The App requests user authorization on install and redirects on update. Its callback and setup URL are both `/github/app/installed`.

The central table `github_apps` holds one row per stage. Each row seals the App's client secret, webhook secret and private key under a data key that `SECRETS_KEK` wraps. At creation, the control plane converts the private key from PKCS#1 to PKCS#8. The key-store port also derives a signing key per purpose from `SECRETS_KEK` with HKDF, and the control plane signs its states with it.

## Installation

A tenant holds one installation per GitHub account or organization it connects. `tumpel github start` answers the install URL `https://github.com/apps/<slug>/installations/new` with a fresh signed state that carries only the tenant and expires after 1 h, so each run connects one more account. While the stage has no App, it answers 409 `GitHubAppMissing`. A person installs the App and authorizes it. The callback exchanges GitHub's code with the client secret. It adds the installation only when GET `/user/installations` for that person lists it, and answers 403 otherwise; it never replaces an installation the tenant already holds, and an installation another tenant holds answers 409. A person who installs the App straight from GitHub comes back without a state. The App requests user authorization on install, so GitHub still sends the installation id and a code; the callback confirms the installation the same way and adds it to the tenant the signed-in person owns, offering a choice when they own several. A refusal on that page names the failure and offers Connect from Tumpel, never GitHub's or the schema's raw text. `tumpel github list` (`GitHubConnections_list`) shows each installation with its account login and type, its repository selection (`All` or `Selected`), its status (`Active` or `Suspended`) and when it was connected. `tumpel github get` reports only the App: `Ready` or `AppMissing`. An Owner removes one installation with `tumpel github delete <installationId>`; the others stay. The App stays installed on GitHub until a person uninstalls it there.

The central table `github_installations` holds one row per installation, many per tenant; central migration 0014 moved each tenant's single link into it. GitHub's webhooks carry only the installation, so this table lives centrally. The control plane receives them at `POST /github/webhook`, outside the public contract. It checks `X-Hub-Signature-256` over the raw body. `installation.deleted` drops only that installation. `installation.suspend` and `unsuspend` set its status, and every installation event and `installation_repositories` refresh its account type and repository selection. A malformed installation event gets 400, and every other delivery gets 204. A migrated row reads `Organization` and `Selected` until GitHub's next event on it.

## Repository token

For a tenant with installations, the control plane picks the one that covers the session's repository: the active installation on the repository's owner, an `All` selection ahead of a `Selected` one. The prebuild dispatch and both listings pick the same way. No covering installation is the same as a repository outside the installation. The control plane signs an RS256 JWT as the App while it prepares the turn offer. It then calls POST `/app/installations/{id}/access_tokens` for the session's repository only. Each call to GitHub gets 10 s. The offer carries the token as `GITHUB_TOKEN` and `GH_TOKEN`. GitHub gives the token 1 h. The claim, the clone and the 3,600 s turn budget add up to more than that, so a push at the end of a full-length turn can get a 401.

Each handover records `repositoryCredentialSource` as `GitHubApp`, `SecretSet` or `None`. The source is `SecretSet` when the tenant has no installation. A repository outside the installation also takes the secret set's `GITHUB_TOKEN` when the set holds one. Without one, the turn fails `RepositoryTokenRefused`, and so does a turn of a tenant with no installation whose set holds no `GITHUB_TOKEN`. A GitHub timeout or any other GitHub error fails the turn the same way. The detail quotes GitHub, and it says to add the repository to the installation only after a 404 or 422. Tenant migration 0012 backfills `None`, and `SecretSet` for an older row that carried `GITHUB_TOKEN`. The control plane checks GitHub's own payloads with zod schemas, outside the TypeSpec contract. Commits carry the identity of the credential source (EDD-001): the App's bot for `GitHubApp`, and for `SecretSet` the GitHub user of the set's `GITHUB_TOKEN`, which the control plane resolves and stores once, when that member is written. A set written before tenant migration 0027 fails its turn until its `GITHUB_TOKEN` is written again. The bot's user id comes from GET `/users/<app-slug>[bot]` when the App is created; an App created before D1 migration 0014 reads it on its first turn.

## Issues

Both listings read GitHub with an installation token. The repository listing, `GitHubConnections_listRepositories`, reads every page of every active installation. For issues, `GitHubConnections_listIssues` reads one page with the installation on the repository's owner: the 100 open issues updated last, without pull requests. A listing refuses with 409 `GitHubNotConnected` while the tenant holds no installation, and with 409 `RepositoryUnreadable` when GitHub refuses any of them.

`Sessions_startFromIssue` takes `owner`, `name`, `issueNumber`, `personaId` and `model`. It reads the issue with the installation token, or else with the persona's `GITHUB_TOKEN`. From the issue, the control plane writes the first prompt and starts the session as a plain start does. It answers `{session, turn, issue}`. A `SessionIssue` holds `sessionId`, `issueNumber`, `title`, `htmlUrl` and `branch`, which is `ticket/<n>-<slug>`. A missing or deleted issue is refused with 404 `IssueNotFound`, a closed issue or a pull request with 409 `IssueNotOpen`, and an issue neither token reads with 409 `RepositoryUnreadable`.

Sessions and prebuilds name a repository in one form: `https://github.com/<owner>/<name>` in lower case, without `.git`. One normaliser writes it for both.

## Audit

Each grant leaves one row in an append-only audit table of the tenant's database. `tumpel session handovers <sessionId>` lists a session's rows, oldest first. A row names the grant, the turn, the host, the variable names and the time. Database triggers refuse an update or a delete of a row.

## FAQ

**Can the harness read the provider credential?** Yes. It reads the credential from its environment, as it does on a developer's machine.

**Can an MCP client set a secret value?** No. Values arrive from environment variables through `tumpel config apply`.
