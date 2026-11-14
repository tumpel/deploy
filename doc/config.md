# Tenant config

A tenant keeps its personas, secret sets, harness pins and host labels in one JSON file, defined by `TenantConfig` in `packages/api/config.tsp` and checked against `packages/api/generated/TenantConfig.json`.

```json
{
  "$schema": "https://raw.githubusercontent.com/mvhenten/tumpel/main/packages/api/generated/TenantConfig.json",
  "personas": [{ "name": "Reviewer", "instructions": "Review the diff.", "settings": "{}", "mcpServers": [] }],
  "secretSets": [
    {
      "name": "prod",
      "secrets": [
        { "name": "ANTHROPIC_API_KEY", "provider": "Anthropic", "valueFrom": { "env": "PROD_ANTHROPIC_API_KEY" } }
      ]
    }
  ],
  "harnessPins": [{ "harness": "ClaudeCode", "harnessVersion": "2.0.0" }],
  "hosts": [{ "hostId": "<from tumpel host list>", "labels": ["gpu"] }]
}
```

The file holds no secret value. `valueFrom.env` names the environment variable `apply` reads it from.

- `tumpel config init <file>` writes a new file from the tenant's current state.
- `tumpel config validate <file>` prints every schema error with its JSON pointer.
- `tumpel config plan <file>` prints each create, update and delete, and changes nothing.
- `tumpel config apply <file>` applies the plan: personas, then secret sets, pins and host labels.

Personas and secret sets match by name, pins by harness, hosts by `hostId`. Whatever the file leaves out is deleted; an unlisted host loses its labels. Secret values are never read back, so a new value under the same key names plans nothing. To rotate a value, change the key name or delete the set and apply again.
