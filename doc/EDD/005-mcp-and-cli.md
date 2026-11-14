# EDD-005: MCP and CLI

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

The MCP server runs on the control plane's Worker, on a path of the control plane's domain. MCP clients sign in through OAuth, and the CLI signs in through a device code. Every signed-in operation is one MCP tool and one CLI command on the same REST handler. A tenant's configuration lives in one file that the CLI validates, plans and applies.

## Sign-in

The control plane serves OAuth protected resource metadata (RFC 9728). It also serves authorization server metadata (RFC 8414). It accepts dynamic client registration (RFC 7591) and authorization with PKCE. On the CLI side, `tumpel login` runs the device flow (RFC 8628): it prints a URL and a code, and a browser approves the code. Cloudflare Access one-time PIN guards the consent, approve and deny pages. Device tokens are stored hashed and work until revoked. The CLI keeps its endpoint and token in a file only the user can read.

A 401 or 403 from the control plane reaches the caller as a signed-out error that says to run `tumpel login`. It never reaches the caller as an empty list.

## Parity

An operation `Group_op` becomes the tool `tumpel_<noun>_<verb>` and the command `tumpel <noun> <verb>`. A build check fails when an operation lacks either one or when the published surface list is stale. Browser-only pages and the OAuth, device-flow and enrolment endpoints carry no principal, so they stay out of both.

Secret-set tools take key names and environment variable names, and they refuse values. They return the config entry that `tumpel config apply` turns into stored values.

## Versioned schemas

The API runs under a version prefix. TypeSpec generates the OpenAPI document, the JSON Schemas, the Worker's Zod schemas and the Rust types, and output that drifts from a fresh generation fails the build. A config file names its schema in `$schema` with the version in the URL. The CLI refuses a version it does not know.

## Config as code

`TenantConfig` holds personas, secret sets, harness pins and host labels. A secret entry names the environment variable its value comes from.

1. `tumpel config init` writes a file from the tenant's current state.
2. `tumpel config validate` prints each schema error with its JSON pointer.
3. `tumpel config plan` prints each create, update and delete, and leaves the tenant as it is.
4. `tumpel config apply` applies the plan: personas, then secret sets, pins and host labels.

Personas and secret sets match by name, pins by harness and hosts by host id. Apply deletes whatever the file leaves out. `--rewrite-secrets <set>` writes fresh values for a set and keeps its id and key names.

## FAQ

**Is there a local MCP server?** No. The MCP server is hosted (ADR-005).

**Can I keep the config file in git?** Yes. It holds no secret value.
