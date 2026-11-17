# 000. Tenets

Status: accepted

These tenets bind every decision in `doc/adr`, `doc/RFC` and `doc/EDD`, next to the tenets of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md#tenets).

1. No logic in the supervisor. The supervisor and the guest pass input through, and the control plane owns harness-specific behaviour. They run on hosts Tumpel does not own and update on their own schedule, so a feature that appears to need a supervisor change looks for a control-plane design first.
2. Tumpel relies on the harness's own features. It never reads or judges a harness transcript, for example to detect an early stop. The harness runs the agent loop, and Tumpel runs the harness.
3. No automatic triggers and no auto-detection. A prebuild runs only when a person or an external trigger starts it, and the user picks its template. The user decides what runs and when.
4. TypeSpec is the single source of truth. Generated output is never written by hand, so the API, the host channel and every config file share one definition.
5. Every input surface has a versioned schema: each API operation, MCP tool, CLI argument and config file. A tenant keeps its config in a file it installs, maintains or keeps in a git repo.
6. What can be created can be read back. Every resource and file written through the API reads back through the API, MCP and the CLI, and only secret values stay write-only. An MCP client edits a persona file only when it can read it.
7. CI time is priority zero. Every change keeps cutting it, measured in minutes per job before and after. Short feedback loops matter to agents as much as to people.
