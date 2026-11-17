# 009. Every turn's GitHub token reaches every installation

Status: accepted

Every turn gets an unscoped installation token for each GitHub account and organization the tenant installed the App on, so an agent reaches every repository the tenant granted the App. A token scoped to the session's repository, or to the one installation that covers it, is rejected. Such a token kept a session on `mvhenten/tumpel` from reaching `tumpel/protocol`.

This follows NFR-5 of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md): the harness runs with full permissions inside its box. The cost is that every agent holds the tenant's whole GitHub grant. The gain is that a session works across all of the tenant's repositories.
