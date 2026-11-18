# Architecture

1. The host supervisor and the guest live in [tumpel/supervisor](https://github.com/tumpel/supervisor), the CLI in [tumpel/cli](https://github.com/tumpel/cli); `release-pins.json` pins the releases tumpel ships. TypeScript for the Cloudflare Workers (`packages/control-plane`) and the Worker that serves the dashboard (`packages/dashboard-site`). The dashboard and `@tumpel/pages` live in [tumpel/dashboard](https://github.com/tumpel/dashboard); tumpel pins their release tarballs.
2. Every config file and every input is defined by a schema.
3. Every platform-specific piece starts as a provider-agnostic interface in TypeSpec or a schema. One swappable backend implements it. Cloudflare is the first backend.
4. Lifecycle is event-driven. No sweeps and no polling.
5. No shared secrets and no standing credentials on hosts.
6. The control plane hosts the MCP server. The `tumpel` CLI is a client of the same public API.
7. The guest image ships build-essential, pkg-config, git, gh, curl, jq, zip, unzip, ripgrep, fd, tree, Node (LTS through fnm), Python (through uv) and a stable Rust toolchain with clippy and rustfmt (`doc/guest-image.md`). Never install them in a box.
8. Supported harnesses: Claude Code, Codex, OpenCode and Pi.dev.
9. Every Cloudflare token, secret and resource is a tofu resource in `packages/control-plane/infra`. Never create one with a script or a manual wrangler step.
10. On the dev stage, apply the tofu with `npm run deploy:infra`, without a plan review.
11. Decisions live in `doc/adr`, designs in `doc/RFC` and `doc/EDD`.
