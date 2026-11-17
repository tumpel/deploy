# RFC: MCP connectors on personas

| Field   | Value                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status  | Proposed                                                                                                                                                                                               |
| Author  | Matthijs van Henten                                                                                                                                                                                    |
| Date    | 2026-11-16                                                                                                                                                                                             |
| Related | [RFC: Tumpel](RFC-TUM-Tumpel.md), [EDD-003](../EDD/003-credentials.md), [EDD-005](../EDD/005-mcp-and-cli.md), [EDD-007](../EDD/007-guest-layers.md), [Dashboard requirements](../product/dashboard.md) |

## Summary

A connector is a remote MCP server that a tenant registers once and attaches to personas. Every turn of every session on such a persona gets the server's tools, in whichever harness the persona runs. A connector signs in one of two ways. An OAuth connector walks the same flow claude.ai walks for a custom connector, and the sign-in belongs to the tenant or to one member. A token connector names a member of the persona's secret set. The supervisor runs an MCP relay beside each box and adds each connector's token on the host, so no connector token enters the box. A connector that fails at turn start fails the turn with a reason that names it, and one persona patch turns it off.

## Requirements

Quoted words are the owner's brief of 2026-11-16.

### Business requirements

- **BR-1 Any MCP server on a persona.** As a tenant, I want to attach "any remote MCP server" to a persona, "so every session on that persona gets it".
- **BR-2 Recall first.** Recall is the first connector.

### Functional requirements

- **FR-1 Register.** An Owner registers a server by URL, with OAuth "like claude.ai custom connectors" or with "a token in a secret set". (BR-1)
- **FR-2 Attach.** A persona lists its connectors. Each turn of its sessions gets every one. (BR-1)
- **FR-3 Every harness.** Claude Code, Codex, OpenCode and Pi.dev each get the relay endpoint in their own config. (BR-1)
- **FR-4 Parity.** Every connector operation is one MCP tool and one CLI command, modelled in TypeSpec first. (BR-1)
- **FR-5 Recall.** Recall attaches as an ordinary OAuth connector. Nothing Recall-specific enters the supervisor or the control plane. (BR-2)

### Non-functional requirements

- **NFR-1 No secret on a command line.** Flags and arguments carry URLs and variable names only.
- **NFR-2 Nothing in snapshots.** No connector token lands in the session overlay.
- **NFR-3 Host only.** No connector token enters a box. The supervisor holds each turn's tokens in memory and never writes them to disk.
- **NFR-4 Budgets.** Each phase below has a budget and a named failure.
- **NFR-5 Events.** A token refreshes only when a turn needs it. Nothing polls a connector.
- **NFR-6 Documented means proven.** Anything Tumpel documents as supported, Tumpel has built and the end-to-end proof has run.

## OAuth sign-in

`tumpel oauth-connector start <name> <url>` (`OAuthConnectors_start`) answers an `authorizeUrl`, as `GitHubConnections_start` does. The control plane is the OAuth client:

| Phase         | Budget | Failure                       | Step                                                                                                                             |
| ------------- | ------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Discovery     | 10 s   | ConnectorDiscoveryFailed      | POST `<url>` without a token, read `resource_metadata` off the 401 (RFC 9728), then the authorization server metadata (RFC 8414) |
| Registration  | 10 s   | ConnectorRegistrationRefused  | Dynamic client registration (RFC 7591) with the redirect `<origin>/connectors/oauth/callback`                                    |
| Authorization | 600 s  | ConnectorAuthorizationExpired | The person consents in the browser. The state is signed as the GitHub state is (EDD-003). PKCE S256, `resource` set to `<url>`   |
| Exchange      | 10 s   | ConnectorTokenRefused         | The callback redeems the code                                                                                                    |

A sign-in is a `TenantConnectorSignIn` or a `MemberConnectorSignIn` (Decision 1). The control plane seals the client registration, the refresh token and the access token with its expiry on the sign-in, under the tenant's data key, with the sign-in id as associated data. The sign-in then reads Connected.

When the control plane prepares an offer, it reuses the access token while it has more than `connectorTokenMinSeconds` (900 s) left. Otherwise it refreshes within 10 s, one refresh per sign-in at a time, so a server that rotates single-use refresh tokens never sees one twice. A refused or timed-out refresh fails the turn `ConnectorRefreshFailed`, quotes the server, and sets the sign-in NotConnected with the fix: connect again. A turn whose sign-in is NotConnected fails `ConnectorNotConnected`.

The supervisor refreshes a token that nears expiry mid-turn (Decision 3). This RFC does not yet say how a rotated refresh token gets back to the control plane.

## Token sign-in

`tumpel token-connector create <name> <url> --secret <SECRET_NAME>` names a secret set member. The persona's own secret set supplies the value, so two personas can reach one server under two accounts. A persona write, start or send is refused `ConnectorSecretMissing` when its set lacks a `Variable` member of that name. The supervisor keeps that member out of the box's environment.

## Handover

Each offer's DispatchGrant adds `connectors`, one flat list of entries keyed by a stable `connectorKey`. Each entry carries its type (OAuth or Token), its owner (Tenant or Member), the name, the URL and the token. When the member who sends the turn has a sign-in to a connector, that entry replaces the tenant's. The supervisor keeps the list in memory for the turn and passes the rest of the grant to the guest. The handover audit row adds the connector keys. The channel and guest protocols each step by one.

## Relay

The supervisor runs the MCP relay next to the box. Inside, the box sees one Tumpel MCP endpoint, `http://127.0.0.1:<relayPort>/mcp`, and the guest carries each call over vsock to the supervisor. For each call, the relay picks the entry, adds its token and forwards the call to the server. A persona's connectors decide which entries the relay exposes. One host gateway serves the relay and the provider keys (Decision 3).

## Failures and the toggle

At turn start the relay calls `initialize` on each entry's server, within 10 s. A failure fails the turn with one reason per cause: `ConnectorUnreachable`, `ConnectorAuthRefused` or `ConnectorTokenExpired`. The detail names the connector key, its owner and its type in plain words and quotes the server. It ends with the toggle: `tumpel persona patch` turns the connector off for the next turn. `tumpel_turn_failure`, the CLI and the dashboard each show that detail.

The toggle is the persona PATCH of Decision 2, which drops a connector's id from the persona's lists or puts it back. It ships as one MCP tool, one CLI command and a switch on the dashboard's persona page. A per-session override can follow. The persona PATCH comes first because Decision 2 already builds it, and an override adds a field to every session.

## Harness wiring

The guest writes generated config to `/run/tumpel`, a tmpfs outside the overlay. Each harness gets the relay endpoint as one streamable HTTP server named `tumpel`.

| Harness     | Config                                                                                                          | Checked                       |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Claude Code | `/run/tumpel/mcp.json` with `mcpServers.tumpel` of `type` `http`, passed as `--mcp-config /run/tumpel/mcp.json` | `--mcp-config` unproven       |
| Codex       | `-c mcp_servers.tumpel.url="<relay>"` beside the image's provider flags                                         | `codex mcp add --help`, 0.147 |
| OpenCode    | `OPENCODE_CONFIG_CONTENT` holding `mcp.tumpel` of `type` `remote`                                               | Merge order unproven          |
| Pi.dev      | `~/.pi/agent/mcp.json` from the persona's files, as the next section says                                       | Pi `docs/mcp.md`, 1.5.2       |

## Pi

Pi has carried MCP as a built-in extension since 0.99.0, and the catalog pins 1.5.2. Pi reads user-level servers from `~/.pi/agent/mcp.json` and connects to a `url` entry over streamable HTTP. The catalog adds `.pi/agent/mcp.json` to Pi's persona file paths, so the persona carries that file:

```json
{ "mcpServers": { "tumpel": { "url": "http://127.0.0.1:<relayPort>/mcp" } } }
```

The maintained third-party extension `pi-mcp-adapter` (Nico Bailon, 7.0.1 of 2026-11-04) reads the same file and turns the built-in one off. The persona needs only the built-in one.

The guest fails a Pi turn on a persona with connectors only when that file is missing, with `ConnectorSetupMissing`. Its detail says in plain words that the persona needs `.pi/agent/mcp.json` with the `tumpel` server at the relay endpoint.

## Proof

The end-to-end proof (EDD-006) adds two steps. A small test MCP server with its own OAuth authorization server runs on the proof host. Agents sign in to it as an OAuth connector with no person in a browser, as step 12 does through the service token. A Pi session on the proof host then reaches the same server through the relay. The server lives in `packages/proof-mcp`, a Node package, because the proof's tooling is Node and the server ships in no host binary. The control plane must reach the server's URL for discovery and the exchange. How the proof host exposes that URL is open.

## Recall

Recall serves seven tools at `<hostname>/mcp` over streamable HTTP. Its only credential is a bearer token from its own OAuth flow: public clients, PKCE S256, 1 h access tokens, 30 d single-use refresh tokens. Tumpel needs no Recall-specific code for it.

A super harness such as Recall reads transcripts through the public transcript read with its cursor (`Transcripts_read`). Inbound, it calls `Sessions_send` on Tumpel's hosted MCP as an OAuth client of Tumpel (FR-14 of RFC: Tumpel), and an order becomes a turn. Both are Recall-side work.

## Build plan

Each stage is one push, in this order.

1. TypeSpec for both connectors, both sign-ins, the persona fields and PATCH, the grant and the failures. The API change needs approval.
2. Token connectors, the grant, the relay, Claude Code and Codex wiring, the protocol step.
3. OAuth connectors, the callback, refresh at offer and in the relay, the Connections card, the toggle.
4. OpenCode and Pi wiring.
5. `TenantConfig`, the test MCP server and the two proof steps.

## Decisions for Matthijs

1. **Who owns the sign-in.** Ruled. Connectors form one flat model. A tenant sign-in and member sign-ins exist from day one, flattened per turn into one keyed list that names each type and owner (Handover). A member's entry takes precedence over the tenant's for the same connector.
2. **Persona fields.** Ruled. A new `Personas_patch` sets a persona's connectors, and a field left out of it stays unchanged. On create, a missing connector list means none. `Personas_update` keeps its full-replace semantics. Matthijs gave the reason: changing one value of a persona is a patch, and a patch never erases anything. Every PUT update in the API gets a PATCH beside it.
3. **Token in the box or a relay.** Ruled: a relay on the host (Relay). The supervisor gets the tokens per turn over the channel, holds them in memory only and refreshes them. One host gateway serves this relay and the per-session virtual keys for provider keys, which RFC: Tumpel lists as a non-goal for v1.
4. **Transcripts to a super harness.** Ruled: nothing built. A super harness reads transcripts through the existing transcript read (Recall).
5. **Pi.** Ruled. Pi reaches connectors through its MCP extension, set up in the persona's files at the relay endpoint (Pi). The guest refuses a Pi turn only without that setup. The proof runs a Pi session through the relay before Tumpel documents the setup (NFR-6).
6. **Proof of OAuth.** Ruled. Agents prove the OAuth sign-in headlessly against a test server on the proof host, which the Pi step also uses (Proof).
7. **Recall.** Ruled. Recall is an ordinary connector to the tenant's own Recall.
8. **A failed server.** Ruled. The turn fails fast with a named reason per cause, and the detail points at the toggle (Failures and the toggle).

## FAQ

**Does a connector token reach the host's disk?** No. The supervisor holds it in memory only.

**Can an MCP client register a connector?** Yes. Start answers a URL a person opens. No secret value passes through MCP.

**Does a server without dynamic client registration work?** No. Registration refuses it, naming the missing endpoint.

**How do I turn a broken connector off?** `tumpel persona patch` drops it from the persona, and the next turn runs without it.

## Appendix of entities

```tsp
@pattern("^[a-z][a-z0-9-]{0,31}$")
scalar ConnectorName extends string;

model OAuthConnector {
  @key @visibility(Lifecycle.Read) oauthConnectorId: EntityId;
  @visibility(Lifecycle.Read) tenantId: EntityId;
  name: ConnectorName;
  url: url;
  @visibility(Lifecycle.Read) createdAt: int64;
  @visibility(Lifecycle.Read) updatedAt: int64;
}

model TenantConnectorSignIn {
  @key @visibility(Lifecycle.Read) tenantConnectorSignInId: EntityId;
  @visibility(Lifecycle.Read) tenantId: EntityId;
  @visibility(Lifecycle.Read) oauthConnectorId: EntityId;
  @visibility(Lifecycle.Read) status: ConnectorSignInStatus;
  @visibility(Lifecycle.Read) createdAt: int64;
  @visibility(Lifecycle.Read) updatedAt: int64;
}

model MemberConnectorSignIn {
  @key @visibility(Lifecycle.Read) memberConnectorSignInId: EntityId;
  @visibility(Lifecycle.Read) tenantId: EntityId;
  @visibility(Lifecycle.Read) principalId: EntityId;
  @visibility(Lifecycle.Read) oauthConnectorId: EntityId;
  @visibility(Lifecycle.Read) status: ConnectorSignInStatus;
  @visibility(Lifecycle.Read) createdAt: int64;
  @visibility(Lifecycle.Read) updatedAt: int64;
}

model ConnectorSignInConnecting {
  kind: "Connecting";
  authorizeUrl: url;
  authorizeExpiresAt: offsetDateTime;
}

model ConnectorSignInConnected {
  kind: "Connected";
  authorizationServer: url;
  connectedAt: offsetDateTime;
}

model ConnectorSignInNotConnected {
  kind: "NotConnected";
  reason: ConnectorFailureReason;
  detail: string;
}

@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union ConnectorSignInStatus {
  Connecting: ConnectorSignInConnecting,
  Connected: ConnectorSignInConnected,
  NotConnected: ConnectorSignInNotConnected,
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

enum ConnectorType {
  OAuth: "OAuth",
  Token: "Token",
}

enum ConnectorOwner {
  Tenant: "Tenant",
  Member: "Member",
}

model DispatchConnector {
  connectorKey: string;
  type: ConnectorType;
  owner: ConnectorOwner;
  name: ConnectorName;
  url: url;
  token: string;
}

enum TurnFailureReason {
  ConnectorNotConnected: "ConnectorNotConnected",
  ConnectorRefreshFailed: "ConnectorRefreshFailed",
  ConnectorUnreachable: "ConnectorUnreachable",
  ConnectorAuthRefused: "ConnectorAuthRefused",
  ConnectorTokenExpired: "ConnectorTokenExpired",
  ConnectorSetupMissing: "ConnectorSetupMissing",
}

model DispatchGrant {
  credentialHandoverId: EntityId;
  expiresAt: offsetDateTime;
  variables: DispatchVariable[];
  connectors: DispatchConnector[];
}
```

Operations: `OAuthConnectors_list`, `_get`, `_start`, `_delete`; `TokenConnectors_list`, `_get`, `_create`, `_update`, `_delete`. Each is one `tumpel_<noun>_<verb>` tool and one `tumpel <noun> <verb>` command. `Personas_create` takes both id arrays as optional, and a list left out means none. `Personas_update` replaces both lists with the rest of the persona. `Personas_patch` changes only the lists in its body. Only an Owner creates or deletes a connector (403 `OwnerRequired`). `OAuthConnectors_start` takes an `owner`. An Owner starts the `TenantConnectorSignIn`, and any member starts their own `MemberConnectorSignIn`. Each start creates or replaces that sign-in. A delete of a connector a persona lists is refused with 409, as a secret set's is. `Connections_list` adds one row per OAuth connector. `TenantConfig` lists token connectors and names OAuth connectors by name; `apply` never creates or deletes an OAuth connector, and stops on a persona naming one that is missing.

## Appendix of sources

| Fact                                                 | Source                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Recall's transport, OAuth flow and token lifetimes   | `recall/README.md`, Custom connector                        |
| Codex `-c` flags and persona `config.toml`           | PR #24                                                      |
| Pi MCP built in since 0.99.0, `~/.pi/agent/mcp.json` | Pi `packages/coding-agent/docs/mcp.md` and CHANGELOG 0.99.0 |
| `pi-mcp-adapter` maintainer, version and date        | npm registry, `pi-mcp-adapter`                              |
| Pi catalog pin 1.5.2 and persona file paths          | `packages/control-plane/src/harness-catalog.ts`             |
| Grant expiry                                         | EDD-003 Handover                                            |
| Virtual keys a non-goal for v1                       | RFC: Tumpel, Credentials and storage                        |
