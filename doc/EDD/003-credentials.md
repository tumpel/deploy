# EDD-003: Credentials

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

A persona names one secret set, and only that set's values reach its sessions. The control plane keeps every value encrypted under a key per tenant, which a deployment master key wraps. For each turn it decrypts the values the persona allows and sends them to the host in the turn offer. In the box, the provider credential lives in a loopback proxy for one turn. The other secrets go into the harness's environment. Every handover leaves an audit record with names and no values.

## Model

A persona carries `secretSetId`. A secret set holds named values, which the API writes and never reads back. The harness catalog lists the variable names each harness accepts as its provider credential, in `credentialNames`. Claude Code accepts `ANTHROPIC_API_KEY` for an API key and `CLAUDE_CODE_OAUTH_TOKEN` for a subscription token. Codex accepts `OPENAI_API_KEY`. A start is refused, with the accepted names listed, when the persona's set holds none of them or more than one.

A start also takes a list of session secrets, which can be empty. The control plane stores them like set values and deletes them when the session is archived.

## Encryption at rest

Each tenant has a data key. Each value is encrypted under it with AES-256-GCM, binding the tenant id, the secret set id and the name as associated data. The deployment's master key wraps every tenant data key. That master key sits behind the key store interface, which the Cloudflare backend fills with a Workers secret. Rotating the master key rewraps the tenant keys and leaves the values as they are.

## Handover

On every send of a turn offer, the control plane resolves the persona to its set, decrypts the values and builds a grant. Each grant holds an id, an expiry 300 s ahead and the variables, and the control plane stores the offer without it. Once the expiry passes, the supervisor fails the turn `CredentialRefused`. Over vsock, the supervisor passes the grant to the guest and writes nothing to disk.

The harness starts once with a placeholder in its credential variable and its base URL variable pointing at a loopback proxy in the box. During a turn, the proxy swaps the placeholder in request headers for the real value and forwards to the provider. Outside a turn the proxy holds nothing and answers 401.

The guest writes the persona's files and exports the other secrets before the harness starts. When either changed since the harness started, the guest restarts the harness at the next turn.

## Audit

Each grant leaves one `CredentialHandover` record. It names the tenant, session, turn, host, box, secret set and variable names, and the time.

## FAQ

**Can the harness read the provider credential?** No. The harness sees the placeholder, and it can read the other secrets in its environment.

**Can an MCP client set a secret value?** No. Values arrive from environment variables through `tumpel config apply`.
