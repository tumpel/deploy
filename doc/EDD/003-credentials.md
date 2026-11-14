# EDD-003: Credentials

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

A persona names one secret set, and only that set's values reach its sessions. The control plane keeps every value encrypted under a key per tenant, which a deployment master key wraps. For each turn it decrypts the values the persona allows and sends them to the host in the turn offer. In the box, the guest exports the provider credential and the other secrets into the harness's environment. Every handover leaves an audit record with names and no values.

## Model

A persona carries `secretSetId`. A secret set holds one provider credential and other named values, which the API writes and never reads back. The provider credential has a kind: an API key, or a subscription token with its expiry. The harness catalog maps each kind to the variable that harness reads, in `credentialVariables`. For Claude Code, an API key maps to `ANTHROPIC_API_KEY` and a subscription token to `CLAUDE_CODE_OAUTH_TOKEN`. Codex takes its API key in `OPENAI_API_KEY`. A start is refused, with the accepted kinds listed, when the catalog maps no variable for the set's credential kind.

A start also takes a list of session secrets, which can be empty. The control plane stores them like set values and deletes them when the session is archived.

## Encryption at rest

Each tenant has a data key. Each value is encrypted under it with AES-256-GCM, binding the tenant id, the secret set id and the name as associated data. The deployment's master key wraps every tenant data key. That master key sits behind the key store interface, which the Cloudflare backend fills with a Workers secret. Rotating the master key rewraps the tenant keys and leaves the values as they are.

## Handover

On every send of a turn offer, the control plane resolves the persona to its set, decrypts the values and builds a grant. Each grant holds an id, an expiry 300 s ahead and the variables, with the provider credential under the name the catalog maps for its kind. The control plane stores the offer without the grant. Once the expiry passes, the supervisor fails the turn `CredentialRefused`. Over vsock, the supervisor passes the grant to the guest and writes nothing to disk.

For each turn, the guest writes the persona's files and exports the variables before the harness starts. When any of them changed since the harness started, the guest restarts the harness before the turn.

## Audit

Each grant leaves one `CredentialHandover` record. It names the tenant, session, turn, host, box, secret set and variable names, and the time.

## FAQ

**Can the harness read the provider credential?** Yes. It reads the credential from its environment, as it does on a developer's machine.

**Can an MCP client set a secret value?** No. Values arrive from environment variables through `tumpel config apply`.
