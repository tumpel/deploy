# EDD-005: MCP and CLI

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

The MCP server runs on the control plane's Worker, on a path of the control plane's domain. MCP clients sign in through OAuth, and the CLI signs in through a device code. Every tenant operation is one MCP tool and one CLI command on the same REST handler. A tenant's configuration lives in one file that the CLI validates, plans and applies.

## Sign-in

`tumpel login` runs the device flow (RFC 8628): it prints a URL and a code, and a browser approves the code. Cloudflare Access one-time PIN guards the consent, approve and deny pages. Device tokens are stored hashed and work until revoked. The CLI keeps its endpoint and token in a file only the user can read.

A 401 or 403 from the control plane reaches the caller as a signed-out error that says to run `tumpel login`. It never reaches the caller as an empty list.

## Members

Each email has one principal, which can belong to more than one tenant. Each membership row in the central store names the tenant, the principal, the role `Owner` or `Member` and when it was created. A device token, an access token and a refresh token each resolve to exactly one membership, and the control plane reads its role live. When an email has more than one membership, the device confirm page and the consent page let the person pick the tenant. Sign-up always creates a new tenant with the caller as its Owner.

Only an Owner manages members and invitations and starts or deletes a connection. Anyone else gets 403 `OwnerRequired`. Removing a member deletes that member's devices and device approvals in the tenant. It also deletes the member's enrolment tokens, OAuth codes and OAuth tokens there. The last Owner stays (409 `LastOwner`).

An invitation is a single-use link, valid for 7 days and bound to one email and role. The Owner copies it from the create response and sends it on. The central table `invitations` keeps only the sha256 of its token. An invitation for an email that is already a member is refused with 409. The accept page sits behind Access. It accepts when the lowercased Access email matches the invitation exactly, and it creates the principal when the email has none. It refuses an expired invitation with 410 `InvitationExpired`, an unknown or spent one with 404 and another email with 403.

## Connecting a client

An MCP client connects to `<origin>/mcp`, where `<origin>` is the stage's origin. The issuer and metadata take the origin from the request.

1. `/mcp` without a valid token answers 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="tumpel"`.
2. That URL serves the protected resource metadata (RFC 9728), and so does the same path without `/mcp`. It names this origin as the authorization server. `/.well-known/oauth-authorization-server[/mcp]` serves the server metadata (RFC 8414).
3. `/oauth/register` registers public clients only (RFC 7591, `token_endpoint_auth_method` `none`), with up to 10 https redirect URIs. Registrations no sign-in used are removed after 1 h.
4. `/oauth/authorize` takes PKCE with S256 only and a verifier of 43 to 128 characters. The optional `resource` (RFC 8707) must be `<origin>/mcp`.
5. `/oauth/consent` sits behind the stage's Access application. People sign in with an Access identity, checked by origin and a `__Host-` CSRF cookie. The proof signs in with its Access service token, bound to the stage's proof common name, which binds the code to the proof principal and tenant.
6. The callback carries the code, `state` and `iss`.
7. `/oauth/token` redeems the code and each refresh token.

| Item               | Lifetime and use                                           |
| ------------------ | ---------------------------------------------------------- |
| Sign-in request    | 10 min                                                     |
| Authorization code | 120 s, single use, bound to `client_id` and `redirect_uri` |
| Access token       | 1 h                                                        |
| Refresh token      | 30 d, single use, replaced by a new one on each refresh    |

Reusing a spent code or refresh token revokes every token of that client and principal. Each bearer token resolves to one membership (tenant and principal).

## Parity

An operation `Group_op` becomes the tool `tumpel_<noun>_<verb>` and the command `tumpel <noun> <verb>`. The owner ruled on 2026-11-15 that the MCP allows it all, so an MCP session sets up and runs a whole tenant. `npm run surface:check` fails when an operation outside its allowlist lacks either one, or when the published surface list ([doc/surface.md](../surface.md)) is stale. Each entry gives a one-line reason, and only operations that are not tenant operations qualify: browser-only pages, the OAuth, OpenID and device-code wire, the host channel's enrolment, release downloads and the build job wire. An entry that names no operation, or one that has a tool, fails the check too.

`EnrolmentTokens_list` lists the tenant's unused, unexpired enrolment tokens without their values, `EnrolmentTokens_revoke` deletes one, and `OAuthGrants_revoke` deletes every token of one of the caller's own grants; `/oauth/revoke` stays the clients' RFC 7009 route.

Secret values never pass through MCP. They arrive through the dashboard, the OAuth connections or `tumpel config apply` on the CLI. Secret-set tools take key names and environment variable names and refuse values. They return the config entry that `tumpel config apply` turns into stored values, and `tumpel_config_apply` refuses a config that carries secret values.

## Versioned schemas

The API runs under a version prefix. TypeSpec generates the OpenAPI document, the JSON Schemas, the Worker's Zod schemas and the Rust types, and output that drifts from a fresh generation fails the build. A config file names its schema in `$schema` with the version in the URL. The CLI refuses a version it does not know.

## Config as code

`TenantConfig` holds personas, secret sets, harness pins and host labels. A secret entry names the environment variable its value comes from. A persona names its harness, its secret set by name, and its files, each as `{ path, from }`. `path` is where the harness reads the file under its home in the box. `from` is the local file's path from the config file's directory.

1. `tumpel config init` writes a file from the tenant's current state.
2. `tumpel config validate` prints each schema error with its JSON pointer.
3. `tumpel config plan` prints each create, update and delete, and writes nothing. It compares persona files by digest.
4. `tumpel config apply` applies the plan: secret sets, then personas, then deletes, pins and host labels. It uploads only the persona files whose digest changed. It stops when a live persona runs another harness than the file names.

Personas and secret sets match by name, pins by harness and hosts by host id. Apply deletes whatever the file leaves out. Apply writes only the values the request carries: a kept set is written again when every variable it names is sent and keeps its values when none is. It keeps the set's id and key names.

## Persona files

A persona carries files, each a row in the tenant's database with its path, size and sha256 digest. Object storage holds the bytes by digest. A persona's harness is set when the persona is created and never changes. A persona that any session ran on stays. The API refuses its delete with 409 and names the sessions. `tumpel config plan` stops on such a delete before apply writes anything. The harness catalog lists the paths each harness accepts:

| Harness     | Paths                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| Claude Code | `.claude/settings.json`, `.claude/CLAUDE.md`, `.claude.json`              |
| OpenCode    | `.config/opencode/opencode.json`, `.config/opencode/AGENTS.md`            |
| Pi.dev      | `.pi/agent/settings.json`, `.pi/agent/models.json`, `.pi/agent/AGENTS.md` |

`PersonaFileLimit` caps a file sent inline at 65,536 bytes and a persona's files at 262,144 bytes. A larger file goes up through a presigned upload URL and is then named by digest. The control plane checks the stored object with a HEAD before it accepts the write.

## Tickets

`npm run ticket -- <issue url> --persona <name>` works one GitHub issue into a draft pull request. It calls `tumpel session start-from-issue` and streams the turn. The control plane writes the first prompt from the issue (EDD-003). That prompt asks the harness for the branch `ticket/<n>-<slug>` and a draft pull request from it. The script then finds the pull request by that branch with gh and prints its URL. A failed turn exits non-zero with its reason. It applies no tenant config. When the tenant has no persona of that name, the script exits with the advice to apply the tenant config first.

## FAQ

**Is there a local MCP server?** No. The MCP server is hosted (ADR-005).

**Can I keep the config file in git?** Yes. It holds no secret value.
