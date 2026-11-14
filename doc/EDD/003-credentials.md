# EDD-003: Credentials

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

A persona names one secret set, and only that set's values reach its sessions. The control plane keeps every value encrypted under one data key per tenant, which a Worker secret wraps. When it sends a turn offer, it decrypts the set's values and puts them in the offer. In the box, the guest exports them into the harness's environment. Every handover leaves an audit record with names and no values.

## Model

`Persona.secretSetId` is a required field. Each tenant starts with a Default secret set, which its Default persona names. Each member of a set has a name and one of three kinds:

- `Variable`, a value the box gets under the member's own name;
- `ApiKey`, a provider's API key;
- `SubscriptionToken`, a provider's subscription token with its `expiresAt`.

A second credential for a provider the set already covers is refused with 409. The API writes values and never reads them back. The harness catalog lists the credential kinds each harness takes and the variable it reads for each. Claude Code takes an API key in `ANTHROPIC_API_KEY` or a subscription token in `CLAUDE_CODE_OAUTH_TOKEN`. Codex and OpenCode take an API key only. A start is refused with `NoCredential` when the persona's set holds no credential for the harness's provider. A delete of a secret set that a persona names is refused with 409.

## Encryption at rest

Each tenant has one data key. The control plane encrypts each value under it with AES-256-GCM, with the secret set id and the member name as associated data. The Worker secret `SECRETS_KEK` wraps every tenant data key. OpenTofu generates it, and the deploy sets it on the Worker. The control plane decrypts values only when it prepares a turn offer.

## Handover

On every send of a turn offer, the control plane resolves the persona to its set and decrypts every member into a grant. The harness's credential goes under the variable the catalog maps for its kind. Every other member goes under its own name. A subscription token past its `expiresAt` fails the turn `CredentialExpired` instead.

Each grant holds an id, an expiry 300 s ahead and the variables. The control plane stores the offer without the grant. Once the expiry passes, the supervisor fails the turn `CredentialRefused`. Over vsock, the supervisor passes the grant to the guest and writes nothing to disk.

For each turn, the guest writes the persona's files and exports the variables before the harness starts. When either changed since the harness started, the guest restarts the harness before the turn.

## Audit

Each grant leaves one row in an append-only audit table of the tenant's database. The API does not serve it. It names the grant, the turn, the host, the variable names and the time. Database triggers refuse an update or a delete of a row.

## FAQ

**Can the harness read the provider credential?** Yes. It reads the credential from its environment, as it does on a developer's machine.

**Can an MCP client set a secret value?** No. Values arrive from environment variables through `tumpel config apply`.
