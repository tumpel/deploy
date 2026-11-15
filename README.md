# tumpel

Harnesses on any hardware, driven over MCP.

Tumpel has three layers:

- **Control plane**: a Cloudflare Worker (`packages/control-plane`) that holds tenants, hosts and sessions, with one SQLite database per tenant.
- **Hosts**: machines a tenant owns, each running `tumpel-supervisor` (`crates/tumpel-supervisor`), which boots a box per session and runs a harness (Claude Code, Codex, OpenCode or Pi.dev; Mistral's coding agent is planned) turn by turn.
- **Clients**: the `tumpel` CLI (`crates/tumpel`), a client of the same public API as the MCP server hosted on the control plane (doc/adr/005), so a terminal or an agent can start sessions and read their turns.

The API is defined once in TypeSpec (`packages/api`) and its OpenAPI and JSON Schema output is committed under `packages/api/generated`.

## Install the CLI

On Linux, install the `tumpel` CLI and sign in:

```sh
curl -fsSL https://api.dev.tumpel.dev/v1/releases/install.sh | sh
tumpel login --endpoint https://api.dev.tumpel.dev
```

## Develop

Needs Node 22 or later and a stable Rust toolchain.

```sh
npm install
npm run check
```

`npm run check` runs Biome, the TypeScript typecheck, `cargo clippy` with warnings as errors, `cargo fmt --check`, and confirms that regenerating the TypeSpec output leaves no diff. `npm run fix` formats everything.

Agent rules live in [AGENTS.md](AGENTS.md); decisions in [doc/adr](doc/adr).
