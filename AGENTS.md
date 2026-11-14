# Agent rules

- [ ] Rust for everything host-side, the CLI and the MCP server (`crates/`).
- [ ] Workers in TypeScript (`packages/control-plane`).
- [ ] TypeSpec first: change `packages/api/main.tsp`, run `npm run generate`, commit `packages/api/generated`. Never hand-write a generated type.
- [ ] Keys are `<entity>Id`; business dates are ISO 8601 strings with an offset; enums are PascalCase.
- [ ] Every config file and input is defined by a schema.
- [ ] One SQLite database per tenant; only tenant configuration is stored centrally.
- [ ] No sweeps or polling: lifecycle is event-driven.
- [ ] No shared secrets, no standing credentials on hosts.
- [ ] Every phase has a time limit and a named failure.
- [ ] Fail fast: no catch-log-rethrow, no retries, no fallbacks. Every error states what failed and the fix.
- [ ] Every platform-specific piece is defined first as a provider-agnostic interface in TypeSpec/schema, then implemented as one swappable backend (Cloudflare first).
- [ ] The MCP server is hosted on the control plane with Recall's auth model; the `tumpel` CLI is a client of the same public API, not a second MCP.
- [ ] Supported harnesses: Claude Code, Codex, OpenCode, Pi.dev; Mistral's coding agent planned.
- [ ] No comments in code.
- [ ] `npm run check` passes before every commit (Biome, typecheck, clippy, rustfmt, generated output in sync). `npm run fix` formats.
