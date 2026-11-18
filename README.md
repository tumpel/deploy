# tumpel

Harnesses on any hardware, driven over MCP.

Tumpel has three layers:

- **Control plane**: a Cloudflare Worker (`packages/control-plane`) that holds tenants, hosts and sessions, with one SQLite database per tenant.
- **Hosts**: machines a tenant owns, each running `tumpel-supervisor` ([tumpel/supervisor](https://github.com/tumpel/supervisor)), which boots a box per session and runs a harness (Claude Code, Codex, OpenCode or Pi.dev; Mistral's coding agent is planned) turn by turn.
- **Clients**: the `tumpel` CLI ([tumpel/cli](https://github.com/tumpel/cli)), a client of the same public API as the MCP server hosted on the control plane (doc/adr/005), so a terminal or an agent can start sessions and read their turns.

The API is defined once in TypeSpec in [tumpel/protocol](https://github.com/tumpel/protocol), whose releases publish the `@tumpel/schemas`, `@tumpel/openapi` and `@tumpel/api` packages this repository installs. `release-pins.json` names the supervisor and CLI releases tumpel ships.

## Install the CLI

On Linux, install the `tumpel` CLI and sign in:

```sh
curl -fsSL https://api.dev.tumpel.dev/v1/releases/install.sh | sh
tumpel login --endpoint https://api.dev.tumpel.dev
```

## Develop

Needs Node 22 or later.

```sh
npm install
npm run check
```

`npm run check` runs Biome, the TypeScript typecheck and the comment, secret, prose and surface checks. `npm run fix` formats everything.

Agent rules live in [AGENTS.md](AGENTS.md); decisions in [doc/adr](doc/adr).
