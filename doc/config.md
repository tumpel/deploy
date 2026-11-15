# Tenant config

A tenant keeps its personas, secret sets, harness pins and host labels in one JSON file, defined by `TenantConfig` in `packages/api/config.tsp` and checked against `packages/api/generated/TenantConfig.json`.

```json
{
  "$schema": "https://raw.githubusercontent.com/mvhenten/tumpel/main/packages/api/generated/TenantConfig.json",
  "personas": [
    {
      "name": "Reviewer",
      "harness": "ClaudeCode",
      "secretSetName": "prod",
      "gitAuthorName": "Tumpel Reviewer",
      "gitAuthorEmail": "reviewer@users.noreply.github.com",
      "files": [{ "path": ".claude/CLAUDE.md", "from": "reviewer/CLAUDE.md" }]
    }
  ],
  "secretSets": [
    {
      "name": "prod",
      "secrets": [
        {
          "kind": "ApiKey",
          "name": "ANTHROPIC_API_KEY",
          "provider": "Anthropic",
          "valueFrom": { "env": "PROD_ANTHROPIC_API_KEY" }
        },
        { "kind": "Variable", "name": "GITHUB_TOKEN", "valueFrom": { "env": "PROD_GITHUB_TOKEN" } }
      ]
    }
  ],
  "harnessPins": [{ "harness": "ClaudeCode", "harnessVersion": "2.0.0" }],
  "hosts": [{ "hostId": "<from tumpel host list>", "labels": ["gpu"] }]
}
```

The file holds no secret value. `valueFrom.env` names the environment variable `apply` reads it from. A box clones the session's repository with the tenant's GitHub App installation token, or else with the set's `GITHUB_TOKEN` Variable (EDD-003), and commits as the persona's `gitAuthorName` and `gitAuthorEmail`; a public repository needs no token. `doc/personas/ticket-worker` is a persona that works a GitHub issue.

- `tumpel config init <file>` writes a new file from the tenant's current state.
- `tumpel config validate <file>` prints every schema error with its JSON pointer.
- `tumpel config plan <file>` prints each create, update and delete, and changes nothing.
- `tumpel config apply <file>` applies the plan: secret sets, personas, deletes, pins and host labels, and writes every secret set's values again.

Personas and secret sets match by name, pins by harness, hosts by `hostId`. Whatever the file leaves out is deleted; an unlisted host loses its labels. Secret values are never read back, so a new value under the same key names plans nothing; apply writes every set's values again, so export each variable the file names. A rewritten set keeps its `secretSetId` and key names.

Plan and apply run on the control plane: `TenantConfigs_plan` takes the file with each persona file's digest, and `TenantConfigs_apply` takes it with each file's bytes and every value. The CLI and the dashboard's setup checklist both call them; the MCP tool `tumpel_config_apply` takes no secret values.

## Set up your own tenant

`doc/personas/tumpel-dev.json` holds the persona `tumpel-dev`, which works on this repository with Claude Code on Opus. Its secret set carries a Claude Code subscription token and a GitHub token. Sign in as yourself and apply it:

1. `tumpel login --endpoint <stage origin>`, such as `https://api.dev.tumpel.dev`.
2. Open the URL it prints in a browser and approve the code.
3. `npm run tenant:apply -- doc/personas/tumpel-dev.json`

`tenant:apply` reads the subscription token and its expiry from `~/.claude/.credentials.json` and the GitHub token from `gh auth token`, in process. It passes them to `tumpel config apply` through the environment only, so a rerun rotates the values. `TUMPEL_CREDENTIAL=dotfiles:<key name>` with `TUMPEL_CREDENTIAL_EXPIRES_AT` reads the token from dotfiles instead. Any other secret the file names must be exported first. `--endpoint <url>` overrides the control plane the CLI env file names; it must be the one you signed in to.
