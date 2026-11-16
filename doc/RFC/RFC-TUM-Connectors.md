# RFC: MCP connectors on personas

| Field   | Value                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status  | Proposed                                                                                                                                                                                               |
| Author  | Matthijs van Henten                                                                                                                                                                                    |
| Date    | 2026-11-16                                                                                                                                                                                             |
| Related | [RFC: Tumpel](RFC-TUM-Tumpel.md), [EDD-003](../EDD/003-credentials.md), [EDD-005](../EDD/005-mcp-and-cli.md), [EDD-007](../EDD/007-guest-layers.md), [Dashboard requirements](../product/dashboard.md) |

## Summary

A connector is a remote MCP server that a tenant registers once and attaches to personas. Every turn of every session on such a persona gets the server's tools, in whichever harness the persona runs. A connector signs in one of two ways. An OAuth connector walks the same flow claude.ai walks for a custom connector, and the control plane keeps the refresh token. A token connector names a member of the persona's secret set. Each turn's offer carries the server's URL and a token for it. The guest wires both into the harness's own MCP config.

## Requirements

Quoted words are the owner's brief of 2026-11-16.

### Business requirements

- **BR-1 Any MCP server on a persona.** As a tenant, I want to attach "any remote MCP server" to a persona, "so every session on that persona gets it".
- **BR-2 Recall first.** Recall is the first connector, with session capture and the agent bus.

### Functional requirements

- **FR-1 Register.** An Owner registers a server by URL, with OAuth "like claude.ai custom connectors" or with "a token in a secret set". (BR-1)
- **FR-2 Attach.** A persona lists its connectors. Each turn of its sessions gets every one. (BR-1)
- **FR-3 Every harness.** Claude Code, Codex, OpenCode and Pi.dev each get the connection in their own config. (BR-1)
- **FR-4 Parity.** Every connector operation is one MCP tool and one CLI command, modelled in TypeSpec first. (BR-1)
- **FR-5 Recall.** Recall attaches as a connector, its sessions reach Recall's archive, and Recall's bus reaches Tumpel sessions. (BR-2)

### Non-functional requirements

- **NFR-1 No secret on a command line.** Flags and arguments carry URLs and variable names only.
- **NFR-2 Nothing in snapshots.** No connector token lands in the session overlay.
- **NFR-3 Per turn.** A connector token reaches a box only in the turn's DispatchGrant.
- **NFR-4 Budgets.** Each phase below has a budget and a named failure.
- **NFR-5 Events.** The control plane refreshes a token only when it prepares an offer. Nothing polls a connector.

## OAuth sign-in

`tumpel oauth-connector start <name> <url>` (`OAuthConnectors_start`) answers an `authorizeUrl`, as `GitHubConnections_start` does. The control plane is the OAuth client:

| Phase         | Budget | Failure                       | Step                                                                                                                             |
| ------------- | ------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Discovery     | 10 s   | ConnectorDiscoveryFailed      | POST `<url>` without a token, read `resource_metadata` off the 401 (RFC 9728), then the authorization server metadata (RFC 8414) |
| Registration  | 10 s   | ConnectorRegistrationRefused  | Dynamic client registration (RFC 7591) with the redirect `<origin>/connectors/oauth/callback`                                    |
| Authorization | 600 s  | ConnectorAuthorizationExpired | The person consents in the browser. The state is signed as the GitHub state is (EDD-003). PKCE S256, `resource` set to `<url>`   |
| Exchange      | 10 s   | ConnectorTokenRefused         | The callback redeems the code                                                                                                    |

The control plane seals the client registration, the refresh token and the access token with its expiry under the tenant's data key, with the connector id as associated data. The connector then reads Connected.

When the control plane prepares an offer, it reuses the access token while it has more than `connectorTokenMinSeconds` (900 s) left. Otherwise it refreshes within 10 s, one refresh per connector at a time, so a server that rotates single-use refresh tokens never sees one twice. A refused or timed-out refresh fails the turn `ConnectorRefreshFailed`, quotes the server, and sets the connector NotConnected with the fix: connect again. A turn on a NotConnected connector fails `ConnectorNotConnected`.

## Token sign-in

`tumpel token-connector create <name> <url> --secret <SECRET_NAME>` names a secret set member. The persona's own secret set supplies the value, so two personas can reach one server under two accounts. A persona write, start or send is refused `ConnectorSecretMissing` when its set lacks a `Variable` member of that name.

## Handover

Each offer's DispatchGrant adds `connectors`: name, URL and the variable that holds the token. A token connector's variable is its member's own name, already in the grant. An OAuth connector's access token goes under `TUMPEL_CONNECTOR_<NAME>`, and a secret member write under the `TUMPEL_` prefix is refused. The handover audit row adds the connector names. The channel and guest protocols each step by one. A refreshed token restarts a warm harness before that turn, as a replaced key does (EDD-003).

## Harness wiring

The guest writes generated config to `/run/tumpel`, a tmpfs outside the overlay, so a snapshot never holds it (NFR-2). Every server is streamable HTTP with a bearer token, added to the persona's own files.

| Harness     | Config                                                                                                                         | Token                             | Checked                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------ |
| Claude Code | `/run/tumpel/mcp.json` with `mcpServers.<name>` of `type` `http`, passed as `--mcp-config /run/tumpel/mcp.json`                | `${VAR}` in `headers`             | Expansion in `--mcp-config` unproven |
| Codex       | `-c mcp_servers.<name>.url="<url>"` and `-c mcp_servers.<name>.bearer_token_env_var="<VAR>"` beside the image's provider flags | Read from the environment by name | `codex mcp add --help`, 0.147        |
| OpenCode    | `OPENCODE_CONFIG_CONTENT` holding `mcp.<name>` of `type` `remote` with `headers`                                               | `{env:VAR}` in the header         | Merge order unproven                 |
| Pi.dev      | None. Pi's README says "No MCP" and points to an extension                                                                     | Not applicable                    | Pi README                            |

When `${VAR}` does not expand there, the guest writes the value into the tmpfs file, which holds no more than the box's environment.

## Recall

Recall serves seven tools at `<hostname>/mcp` over streamable HTTP. Its only credential is a bearer token from its own OAuth flow: public clients, PKCE S256, 1 h access tokens, 30 d single-use refresh tokens. That fits an OAuth connector with no Recall-specific code. The connector runs in no repository, so a save from a box names `tags`.

Session capture today runs in Claude Code hooks, through the `recall` CLI and a device token that works until revoked. Tumpel stores every transcript line (EDD-004). Decision 4 picks one of two readings.

1. The control plane forwards each stored transcript chunk to Recall's `POST /v2/sessions/:id/records` on the chunk write. Recall must accept the connector's bearer on those routes. Recall indexes Claude Code's JSONL only, so other harnesses' lines land unindexed.
2. The box runs the recall plugin and CLI with `RECALL_TOKEN` from the secret set. Only Claude Code has the hooks, and the device token is a standing credential.

### Agent bus

The agent bus delivers through Claude Code's cross-session inbox, behind a server gate, to a listener daemon per host. A box is paused between turns and has no inbox. Outbound, `recall_send` from a box works through the connector. Inbound, Recall calls `Sessions_send` on Tumpel's hosted MCP as an OAuth client of Tumpel (FR-14 of RFC: Tumpel), and an order becomes a turn. That is Recall-side work.

The brief that named Recall "Layer 3" is not in `doc/`, so this section traces only to the brief above.

## Build plan

Each stage is one push, in this order, after Decisions 1 to 3.

1. TypeSpec for both connectors, the persona fields, the grant and the failures. The API change needs approval.
2. Token connectors, the grant, Claude Code and Codex wiring, the protocol step.
3. OAuth connectors, the callback, refresh at offer, the Connections card.
4. OpenCode, and Pi by Decision 5.
5. `TenantConfig`, and the proof by Decision 6.
6. Recall by Decisions 4 and 7, partly in the recall repo.

## Decisions for Matthijs

1. **Whose OAuth grant.** Recommend one grant per connector, held by the tenant. Alternative: one grant per member, as claude.ai keeps, which keeps members' Recall memories apart.
2. **Persona fields.** Recommend both id arrays required on create and update, a breaking change shipped with the dashboard and `TenantConfig`. Alternative: both default to empty, Persona's one optional input.
3. **Token in the box or a relay.** Recommend the token in the grant, as provider keys travel, though Recall's 1 h token can lapse inside a 3,600 s turn. Alternative: the control plane relays every MCP call and adds the token, through a new endpoint on the Worker.
4. **Recall session capture.** Recommend the control plane forwarding transcript chunks to Recall, for every harness, once Recall takes the connector's bearer. Alternative: the recall plugin in the box, Claude Code only, on a standing device token.
5. **Pi.** Recommend refusing a Pi persona with connectors, `ConnectorUnsupported`. Alternative: an MCP extension in the Pi harness layer.
6. **Proof of OAuth.** Recommend a test MCP server with its own OAuth on the proof host, signed in to with a service token. Alternative: the proof covers token connectors only, and a person proves OAuth against Recall once.
7. **Recall as an add-on.** Recommend an ordinary OAuth connector to the tenant's own Recall. Alternative: Tumpel runs a Recall per tenant as a switchable add-on.
8. **A failed server.** Recommend failing the turn `ConnectorFailed` when the harness's init line reports a server unreachable. Alternative: the turn runs without it.

## FAQ

**Does a connector token reach the host's disk?** No. It travels in the grant over vsock into box memory, as a provider key does.

**Can an MCP client register a connector?** Yes. Start answers a URL a person opens. No secret value passes through MCP.

**Does a server without dynamic client registration work?** No. Registration refuses it, naming the missing endpoint.

## Appendix of entities

```tsp
@pattern("^[a-z][a-z0-9-]{0,31}$")
scalar ConnectorName extends string;

model OAuthConnector {
  @key @visibility(Lifecycle.Read) oauthConnectorId: EntityId;
  @visibility(Lifecycle.Read) tenantId: EntityId;
  name: ConnectorName;
  url: url;
  @visibility(Lifecycle.Read) status: OAuthConnectorStatus;
  @visibility(Lifecycle.Read) createdAt: int64;
  @visibility(Lifecycle.Read) updatedAt: int64;
}

model OAuthConnectorConnecting {
  kind: "Connecting";
  authorizeUrl: url;
  authorizeExpiresAt: offsetDateTime;
}

model OAuthConnectorConnected {
  kind: "Connected";
  authorizationServer: url;
  connectedAt: offsetDateTime;
}

model OAuthConnectorNotConnected {
  kind: "NotConnected";
  reason: ConnectorFailureReason;
  detail: string;
}

@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union OAuthConnectorStatus {
  Connecting: OAuthConnectorConnecting,
  Connected: OAuthConnectorConnected,
  NotConnected: OAuthConnectorNotConnected,
}

enum ConnectorFailureReason {
  ConnectorDiscoveryFailed: "ConnectorDiscoveryFailed",
  ConnectorRegistrationRefused: "ConnectorRegistrationRefused",
  ConnectorAuthorizationExpired: "ConnectorAuthorizationExpired",
  ConnectorTokenRefused: "ConnectorTokenRefused",
  ConnectorRefreshFailed: "ConnectorRefreshFailed",
}

model TokenConnector {
  @key @visibility(Lifecycle.Read) tokenConnectorId: EntityId;
  @visibility(Lifecycle.Read) tenantId: EntityId;
  name: ConnectorName;
  url: url;
  secretName: SecretName;
  @visibility(Lifecycle.Read) createdAt: int64;
  @visibility(Lifecycle.Read) updatedAt: int64;
}

model Persona {
  oauthConnectorIds: EntityId[];
  tokenConnectorIds: EntityId[];
}

model DispatchConnector {
  name: ConnectorName;
  url: url;
  tokenVariable: SecretName;
}

model DispatchGrant {
  credentialHandoverId: EntityId;
  expiresAt: offsetDateTime;
  variables: DispatchVariable[];
  connectors: DispatchConnector[];
}
```

Operations: `OAuthConnectors_list`, `_get`, `_start`, `_delete`; `TokenConnectors_list`, `_get`, `_create`, `_update`, `_delete`. Each is one `tumpel_<noun>_<verb>` tool and one `tumpel <noun> <verb>` command. Only an Owner starts, creates or deletes one (403 `OwnerRequired`). A delete of a connector a persona lists is refused with 409, as a secret set's is. `Connections_list` adds one row per OAuth connector. `TenantConfig` lists token connectors and names OAuth connectors by name; `apply` never creates or deletes an OAuth connector, and stops on a persona naming one that is missing.

## Appendix of sources

| Fact                                               | Source                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| Recall's transport, OAuth flow and token lifetimes | `recall/README.md`, Custom connector                          |
| Recall's capture, bus and board                    | `recall/README.md`, Live sessions and Messaging between hosts |
| Codex `-c` flags and persona `config.toml`         | PR #24                                                        |
| Pi has no MCP                                      | Pi README, installed copy                                     |
| Grant expiry, restart on changed variables         | EDD-003 Handover                                              |
