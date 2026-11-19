# RFC: Connectors

| Field   | Value                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Draft                                                                                                                                                                                                                                                                                                         |
| Scope   | Design only; MCP and API; no benchmarks                                                                                                                                                                                                                                                                       |
| Related | [Credentials](../EDD/003-credentials.md), [MCP and CLI](../EDD/005-mcp-and-cli.md), [The proof](../EDD/006-end-to-end-proof.md), [Protocol compatibility](../EDD/009-protocol-compatibility.md), [ADR 007](../adr/007-connector-forwarder.md), [ADR 008](../adr/008-connector-dynamic-client-registration.md) |

## Summary

A connector is a remote MCP server that a tenant connects once, with one credential. A persona lists its connectors. Each session copies that list when it starts. An Owner starts OAuth from chat, and the browser returns to the Worker's callback.

Inside each box, a loopback forwarder in the guest adds the current access token to every upstream request. The forwarder fetches that token from the Worker over HTTPS. The tenant Durable Object holds the refresh token and refreshes it. A tool call keeps working after an access token expires, so a turn keeps its full 3,600 s budget. A failed upstream request fails that one tool call, and the turn goes on.

The design extends the Worker, the tenant Durable Object, its encrypted storage, the dispatch grant and the guest in tumpel/supervisor. It adds one loopback listener to each running box.

## Naming and scope

Decision D1: "connector" means MCP access from a session. The GitHub App is a "repository integration". GitHub Actions, CircleCI and Namespace are "build integrations". Existing operations, tables and `Connections_list` keep their names, and the docs call that list infrastructure integrations. An inbound MCP client stays an OAuth grant. A GitHub MCP connector holds its own credential, apart from the repository integration.

Decision D2: a connector is a public HTTPS server that speaks Streamable HTTP. It holds one of two credentials: an OAuth authorization-code grant, or one static token that the forwarder sends as `Authorization: Bearer`. Tumpel, Recall, Linear and Sentry use OAuth. A GitHub PAT uses a static token. Context7 takes either. A connector URL never carries a credential or a secret query parameter.

Out of scope: the dashboard, a marketplace, managed MCP hosting, host or cloud relays, provider-specific adapters, tool aggregation and permissions, member credential overrides, unauthenticated servers, custom credential headers, stdio, private-network and desktop endpoints, legacy SSE and device-grant OAuth.

## Requirements

1. R1: An Owner attaches "any remote MCP server" to a persona, "so every session on that persona gets it". Source: owner's brief, 2026-11-16.
2. R2: Recall is the first connector. Source: ruled draft, 2026-11-16 (BR-2).
3. R3: An Owner connects a server with OAuth "like claude.ai custom connectors" or with a token. Every operation is one MCP tool and one CLI command, so chat can start OAuth. Source: owner's brief and ruled draft (FR-4).
4. R4: Owners manage connectors. A connected account serves every session in the tenant. Source: D12.
5. R5: A tool call keeps working across access-token expiry in every catalog harness. The refresh token never leaves the tenant Durable Object. Source: ruling 3 of 2026-11-16 (mid-turn refresh) and `rules/architecture.md` 5.
6. R6: No connector credential appears on a command line, in a snapshot, an API read, a log, a transcript or a channel ledger. Source: ruled draft (NFR-1, NFR-2).
7. R7: Every phase has a time limit and a named failure that names the connector and the fix. Source: `rules/errors.md` 9.
8. R8: Tumpel documents a connector path only after the end-to-end proof runs it. Source: ruled draft (NFR-6).

## Attachments

Decision D3: `Personas_create` and `Personas_update` take a required `connectorIds` list. Session start and start-from-issue copy the persona's list onto the session. A persona edit changes later sessions only. A member changes a session's tools by choosing a persona. The control plane rejects a duplicate id and a connector from another tenant.

A tenant config persona lists its connectors by name. The tenant transaction resolves each name to an id, and an unknown name fails the plan. Config apply never writes a connector credential.

## API and MCP surface

Decision D4: TypeSpec models every operation. `StaticConnector` and `OAuthConnector` are two variant models with no `kind` field (`rules/typespec.md` 6). Every write is conditional on `updatedAt`. Reads expose metadata, readiness, expiry and the sanitized failure.

| REST under `/v1`                                   | Operation                           | Input and result                                               |
| -------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `GET /connectors`, `GET /connectors/{connectorId}` | `Connectors_list`, `Connectors_get` | Both variants with status                                      |
| `POST /static-connectors`                          | `StaticConnectors_create`           | Name and URL                                                   |
| `POST /oauth-connectors`                           | `OAuthConnectors_create`            | Name, URL and scopes                                           |
| `PUT /connectors/{connectorId}`                    | `Connectors_update`                 | Name                                                           |
| `DELETE /connectors/{connectorId}`                 | `Connectors_delete`                 | Deletes the connector and its credential (D5)                  |
| `POST /oauth-connectors/{connectorId}/authorize`   | `OAuthConnectors_authorize`         | Authorize URL, attempt id and expiry                           |
| `PUT /static-connectors/{connectorId}/token`       | `StaticConnectors_setToken`         | REST writes the token. The MCP tool returns stdin instructions |
| `DELETE /connectors/{connectorId}/credential`      | `Connectors_clearCredential`        | Disconnects the connector for new turns (D13)                  |

Each operation has one `tumpel_connector_*` MCP tool and one `tumpel connector` CLI command. A secret enters the CLI through `--stdin`. The URL and the auth configuration are immutable. A new endpoint means a new connector.

`GET /connectors/oauth/callback` is browser OAuth wire outside MCP. It reports success or failure and sends the user back to chat. Chat reads completion through `Connectors_get`.

## Data and credentials

Decision D5: numbered migrations add these tenant SQLite tables. Every column is mandatory. Mutable records carry timestamps and take conditional writes. The tables reuse [tenant data keys](../../packages/control-plane/src/tenant.ts), the [envelope and key-store code](../../packages/control-plane/src/envelope.ts) and `SECRETS_KEK`. Credentials seal under the context `connector/<connectorId>/credential`. Verifiers seal under a separate purpose.

| Table                                      | Fields beyond timestamps                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `connector_names`                          | Connector id PK, name UNIQUE                                                                      |
| `static_connectors`                        | Connector PK and FK, URL                                                                          |
| `oauth_connectors`                         | Connector PK and FK, URL, scopes                                                                  |
| `static_connector_tokens`                  | Static connector PK and FK, sealed token                                                          |
| `oauth_connector_grants`                   | OAuth connector PK and FK, issuer, token endpoint, client id, sealed bundle                       |
| `connector_authorizations`                 | Attempt PK, OAuth connector FK UNIQUE, initiator id, state hash UNIQUE, sealed verifier, deadline |
| `connector_disconnections`                 | Connector PK and FK, disconnect time                                                              |
| `connector_authorization_failures`         | Connector PK and FK, reason, safe detail                                                          |
| `persona_connectors`, `session_connectors` | Composite PK of the referenced ids                                                                |

`connector_names` holds every name once, so the schema enforces one name across both kinds. The sealed bundle is a TypeSpec variant: with a refresh token, or an access token alone. Secret-set tables and operations never see a connector credential.

`Connectors_delete` refuses with 409 `ConnectorInUse` while a persona lists the connector or a Running turn uses it. `session_connectors` cascades on delete, so later turns of those sessions run without the connector.

Reauthorization replaces the grant row in place after a successful exchange. A running turn picks up the new token at its next fetch (D12). Disconnect cancels pending authorization attempts.

## OAuth from chat

Decision D6: the Worker is the OAuth client of the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). It discovers protected-resource and authorization-server metadata and pins the issuer and resource. It requires HTTPS and S256. It sends `resource` on the authorization and token requests. It blocks private, loopback and link-local destinations through discovery, registration, redirects and exchange. It never forwards a token across an upstream redirect.

The Worker registers a public client through dynamic client registration (RFC 7591) on each authorization. A server that advertises no registration endpoint fails `ConnectorRegistrationUnsupported`. The Worker requests the provider's advertised scopes, with `offline_access` when the provider advertises it. [ADR 008](../adr/008-connector-dynamic-client-registration.md) records the provider evidence.

An authorize call creates a single-use attempt that lasts 10 minutes. Signed state binds the tenant, connector, attempt and initiating principal, and its stored hash stops a replay. The browser opens provider consent. The callback checks the state, the deadline, the issuer and the initiator's current Owner membership. It redeems the code with the sealed verifier and the exact redirect URI. It stores the bundle before the connector reads Connected. Cloudflare Access must leave the callback reachable.

Discovery, registration and exchange each get 10 s. They fail `ConnectorDiscoveryFailed`, `ConnectorRegistrationUnsupported`, `ConnectorAuthorizationDenied`, `ConnectorAuthorizationExpired` or `ConnectorTokenExchangeFailed`. The Worker sanitizes provider errors and never quotes a token response.

| Provider   | Path                                                    |
| ---------- | ------------------------------------------------------- |
| Tumpel     | OAuth with DCR                                          |
| Recall     | OAuth with DCR                                          |
| GitHub MCP | Static token (PAT)                                      |
| Linear     | OAuth with DCR                                          |
| Sentry     | OAuth with DCR                                          |
| Context7   | OAuth with DCR at `/mcp/oauth`, or an API key at `/mcp` |

Each provider's allowlist, consent screen and refresh-grant lifetime are acceptance conditions. A provider that advertises DCR can still refuse Tumpel's registration.

## Forwarder

Decision D7: the guest runs one forwarder for every connector ([ADR 007](../adr/007-connector-forwarder.md)). A connector whose access token expires with no refresh token fails its calls `ConnectorAuthRefused` until an Owner reconnects it.

Decision D8: the forwarder listens on `127.0.0.1` in each running box. Each connector gets a fixed route, `http://127.0.0.1:<port>/connectors/<connectorId>`. The generated harness config holds these URLs and no secret. The forwarder rejects a foreign `Host` and any browser `Origin`, so a browser in the box reaches no route. It refuses every request with `ConnectorTurnNotRunning` while no turn runs. It strips `Host`, `Origin` and hop-by-hop headers and adds the upstream credential.

The forwarder sends POST, GET and DELETE to the connector's URL. It streams JSON and SSE and passes cancellation, the `Mcp-*` session and protocol headers and `Last-Event-ID`. It rewrites a transport reconnect location to the fixed route or rejects it. It never buffers a whole tool response.

A failed upstream request fails its tool call, and the turn goes on. The forwarder returns the sanitized status as the call's result, and the harness hands that error to the model. Upstream 401 and 403 read `ConnectorAuthRefused`. The forwarder drops the OAuth challenge, so the harness never starts native OAuth. A network error reads `ConnectorUnreachable`. Connect and first byte share a 10 s budget, and a miss fails the call `ConnectorUnreachable`. The turn budget bounds an idle stream. The forwarder never retries or replays a request.

## Token endpoint

Decision D9: the forwarder fetches tokens from the Worker over HTTPS, the way a setup box writes its token through `ClaudeSetupBoxes_writeToken`. The dispatch grant gives each connector its id, URL and a turn bearer. The bearer is an HMAC of tenant, turn and connector under a key that the key-store port derives. The forwarder sends it to `POST /v1/turns/{turnId}/connectors/{connectorId}/token`. The handler is the admission check. It accepts the bearer while the turn is Running and the session lists the connector. It answers with the access token and its expiry. The supervisor sees the bearer and never a connector token. The host channel keeps its messages.

Before each request, the forwarder fetches a new access token when fewer than 30 s remain. A token with no stated expiry is fetched once. When the upstream refuses it, the call fails `ConnectorAuthRefused`. An open stream keeps the token it started with, and later requests use the new one. A provider that ends an established stream ends that tool call.

The tenant Durable Object runs one in-memory refresh promise per connector, and concurrent callers wait on it. It persists the rotated bundle before it replies. When an eviction loses a rotated token mid-exchange, the next refresh gets `invalid_grant`, and the Owner reconnects.

A token fetch gets 15 s, and the provider refresh inside it gets 10 s. A timeout or a refused refresh fails the tool call `ConnectorRefreshFailed`. On `invalid_grant`, the Durable Object records an authorization failure whose fix is to reconnect. The forwarder never sends an expired token.

## Harness files and caches

Decision D10: the guest writes generated config after persona files, under the tmpfs `/run/tumpel/connectors`. It reserves `tumpel-<connectorId>` keys and rejects collisions. The config changes only when the session's attachments change, so only then does the guest restart a harness for connectors (EDD-003). Before a pause or snapshot, the forwarder discards its cached tokens. The guest bind-mounts generated config over native paths where a harness needs it. Conversation state resumes through the existing harness resume path.

| Pinned harness      | Generated config                                                                             | Observed MCP writes and credential stores                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code 2.1.325 | `--mcp-config` with `mcpServers.<key>={type:"http",url}`; the persona's `.claude.json` stays | `~/.claude.json` holds mutable MCP and project state; backups under `~/.claude/backups`; Linux OAuth store `~/.claude/.credentials.json`. The artifact shows the negative-cache basename `mcp-needs-auth-cache.json`; acceptance tracing finds its resolved location. [Settings](https://code.claude.com/docs/en/settings), [credential docs](https://code.claude.com/docs/en/authentication#credential-management), [pinned distribution](https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/2.1.325) |
| Codex 0.169.0       | Runtime `.codex/config.toml`, `[mcp_servers.<key>]` with the local URL                       | Config edit commands write `config.toml`. Native OAuth uses the keyring or `$CODEX_HOME/.credentials.json`, with secrets backend `$CODEX_HOME/secrets/mcp_oauth.age` and locking. [Config writer](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/config/edit/document_helpers.rs), [stores](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/rmcp-client/src/oauth.rs)                                                                                                            |
| OpenCode 1.19.5     | Runtime `.config/opencode/opencode.json`, v1 `mcp.<key>={type:"remote",url,oauth:false}`     | Native OAuth writes `$XDG_DATA_HOME/opencode/mcp-auth.json`, by default under `~/.local/share/opencode`. Logs go to its `log/`, cache to `~/.cache/opencode`, state to `~/.local/state/opencode`. [Auth writer](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/mcp/auth.ts), [paths](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/global.ts)                                                                                                                     |
| Pi 1.5.2            | Runtime `.pi/agent/mcp.json`, `mcpServers.<key>={url}`                                       | MCP commands and toggles write `~/.pi/agent/mcp.json` or a trusted project's `.pi/mcp.json`. OAuth writes `mcp-auth.json` with file and refresh locks. Notifications append `mcp.log` and rotate `mcp.log.1`. [Pinned source directory](https://github.com/earendil-works/pi/tree/v1.5.2/packages/coding-agent/src/extensions/mcp)                                                                                                                                                                                 |

The table lists MCP writes only. Source confirms the OpenCode and Pi paths and the Codex stores. Claude Code ships closed, so acceptance tracing finds its negative-cache path, and a tmpfs mount covers it before release.

Generated config stays on tmpfs. Native OAuth caches stay empty for managed connectors, and the guest never seeds them. Runtime mounts cover the listed credential and cache files and their locks, and leave ordinary conversation data alone. A cold restore starts fresh runtime mounts. An agent can still copy an access token it reads into its repository.

## Delivery and acceptance

Decision D11: implementation waits for approval of this design. The connector types and the dispatch grant field land in tumpel/protocol first. A tumpel PR then bumps the `@tumpel/schemas`, `@tumpel/openapi` and `@tumpel/api` tarball URLs. The guest and its forwarder ship in a tumpel/supervisor release, and `release-pins.json` pins it. EDD-003 gains the connector credential contract. The control plane refuses a connector turn on a host whose supervisor predates the forwarder.

1. EDD-006 gains a connector step. A test MCP server with its own OAuth authorization server runs on the proof host. The proof signs in to it with no person in a browser, as step 12 does through the service token. The test server issues short-lived access tokens, so a Claude Code tool call crosses expiry. We do not know yet how the proof host gives the Worker a public HTTPS URL for that server.
2. Each pinned harness makes a tool call after access-token expiry. The tests cover SSE, cancellation, session headers, concurrent refresh and a lost provider response. An upstream 5xx and a first-byte timeout each fail one tool call, and the turn completes.
3. Disconnect runs before the first fetch, across token expiry, during concurrent turns and during reconnection. Running turns keep refreshing. New turns get `ConnectorDisconnected`.
4. A person runs Tumpel and Recall browser consent once. Separate tests cover external-provider admission. Tests check readiness within 30 s per connector, warm restart, cold restore, filesystem writes, snapshot exclusion and secret-free logs and ledgers. Pi and OpenCode never start native OAuth against a loopback route.

## Confirmed decisions

Decision D12: connector accounts are tenant-wide and Owner-managed. Every session in the tenant can use a connected account. Personas and session attachments select tools; they provide no account privacy boundary.

Decision D13: disconnect affects new turns only. The tenant Durable Object marks the connector disconnected and refuses new turn authorizations with `ConnectorDisconnected`, including pending dispatches that have not begun running. Running turns keep their token fetches and refresh until they finish. Disconnect never interrupts their harness, forwarder or streams. The Durable Object serializes admission and disconnect. New turns need a reconnect or a persona without the connector.

While a disconnected connector serves a running turn, stopping that turn is the only way to cut its credential off. When the last Running turn that uses it ends, the turn-end handler deletes the credential in one query. With no turn running, disconnect deletes it at once. Tumpel deletes the credential locally and leaves the upstream grant in place. The Owner revokes that grant on the provider's site.

## FAQ

### Can OAuth start in chat?

Yes. D6 returns an authorize link, and the callback stores the credential. Consent stays in the browser.

### Where does refresh run?

In the tenant Durable Object (D9). The forwarder fetches access tokens from the Worker over HTTPS and adds them per request.

### Does token expiry end a long turn?

No. D8 fetches a new token 30 s before expiry. A failed refresh fails one tool call, and the turn goes on.

### What happens when an upstream server fails mid-turn?

The tool call fails with `ConnectorUnreachable` or the sanitized status (D8). The model sees the error and continues the turn.

### Can a member connect their own account?

No. D12 shares one Owner-managed account per connector across the tenant.

### How does an Owner cut off a leaked credential?

Disconnect blocks new turns (D13). The Owner stops each running turn that uses the connector and revokes the grant at the provider.

### Which servers can a tenant not connect?

Unauthenticated servers, stdio servers and OAuth servers with no dynamic client registration (D2, D6).
