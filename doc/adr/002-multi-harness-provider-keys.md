# 002. Provider keys follow personas, secret sets and dispatch credentials

Status: accepted, 2026-11-14

Tumpel is multi-harness and not tied to a single model vendor. The supported harnesses are Claude Code, Codex, OpenCode and Pi.dev, and Mistral's coding agent is planned. Provider credentials follow personas, secret sets and per-session dispatch credentials. A persona names which secret sets a session may use, and a secret set holds the provider keys for one or more harnesses. At dispatch time each session receives its own short-lived credentials, so no standing provider key lives on a host. The model is generalised across harnesses, so adding one means mapping its provider keys onto existing secret sets rather than adding a new credential path.
