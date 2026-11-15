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

Each stage has one GitHub App. A person creates it once from GitHub's manifest flow at the browser page `/github/app/setup`, and GitHub returns to `/github/app/created`. The stage's Cloudflare Access application covers both pages and refuses the proof's service token. Adding `?organization=<login>` creates the App under that organization. Once an App exists, the page refuses.

The manifest asks for write on contents, pull requests, issues and discussions. It also asks for write on checks, statuses and workflows, and for read on metadata and actions. It leaves out the administration, members, organization and secrets permissions. The App requests user authorization on install and redirects on update. Its callback and setup URL are both `/github/app/installed`.

The central table `github_apps` holds one row per stage. Each row seals the App's client secret, webhook secret and private key under a data key that `SECRETS_KEK` wraps. At creation, the control plane converts the private key from PKCS#1 to PKCS#8. The key-store port also derives a signing key per purpose from `SECRETS_KEK` with HKDF, and the control plane signs its states with it.

## Installation

A tenant connects with `tumpel github start`. It answers the install URL with a signed state that carries only the tenant and expires after 1 h. While the stage has no App, it answers 409 `GitHubAppMissing`. A person installs the App and authorizes it. The callback exchanges GitHub's code with the client secret. It links the installation only when GET `/user/installations` for that person lists it, and answers 403 otherwise. `tumpel github get` reports the link as `Connected`, `NotConnected` or `AppMissing` and shows no secret.

The central table `github_installations` links one installation to one tenant. GitHub's uninstall webhook carries only the installation id, so this table lives centrally. The control plane receives that webhook at `POST /github/webhook`, outside the public contract. It checks `X-Hub-Signature-256` over the raw body. Only `installation.deleted` removes the link. A malformed installation event gets 400, and every other delivery gets 204. A suspend or an unsuspend leaves the link in place, and a mint against a suspended installation fails with GitHub's own message.

## Repository token

For a linked tenant, the control plane signs an RS256 JWT as the App while it prepares the turn offer. It then calls POST `/app/installations/{id}/access_tokens` for the session's repository only. Each call to GitHub gets 10 s. The offer carries the token as `GITHUB_TOKEN` and `GH_TOKEN`. GitHub gives the token 1 h. The claim, the clone and the 3,600 s turn budget add up to more than that, so a push at the end of a full-length turn can get a 401.

Each handover records `repositoryCredentialSource` as `GitHubApp`, `SecretSet` or `None`. The source is `SecretSet` when the tenant has no installation. A repository outside the installation also takes the secret set's `GITHUB_TOKEN` when the set holds one. Without one, the turn fails `RepositoryTokenRefused`. A GitHub timeout or any other GitHub error fails the turn the same way. The detail quotes GitHub, and it says to add the repository to the installation only after a 404 or 422. Tenant migration 0012 backfills `None`, and `SecretSet` for an older row that carried `GITHUB_TOKEN`. The control plane checks GitHub's own payloads with zod schemas, outside the TypeSpec contract.

## Audit

Each grant leaves one row in an append-only audit table of the tenant's database. `tumpel session handovers <sessionId>` lists a session's rows, oldest first. A row names the grant, the turn, the host, the variable names and the time. Database triggers refuse an update or a delete of a row.

## FAQ

**Can the harness read the provider credential?** Yes. It reads the credential from its environment, as it does on a developer's machine.

**Can an MCP client set a secret value?** No. Values arrive from environment variables through `tumpel config apply`.
