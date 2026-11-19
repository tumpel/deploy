# Tenant config

A tenant keeps its personas, secret sets, harness pins and host labels in one JSON file, defined by `TenantConfig` in the TypeSpec of tumpel/protocol (`typespec/lib/config.tsp`).

```json
{
  "personas": [
    {
      "name": "Reviewer",
      "harness": "ClaudeCode",
      "secretSetName": "prod",
      "connectorNames": [],
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
  "harnessPins": [{ "harness": "ClaudeCode", "harnessVersion": "2.1.325" }],
  "hosts": [{ "hostId": "<from tumpel host list>", "labels": ["gpu"] }]
}
```

The file holds no secret value. `valueFrom.env` names the environment variable `apply` reads it from. A box clones the session's repository with the tenant's GitHub App installation token, or else with the set's `GITHUB_TOKEN` Variable (EDD-003), and commits as the App's bot or as the GitHub user of that token (EDD-001). Nobody enters a git identity. Apply reads the token's GitHub user when it writes the `GITHUB_TOKEN` member, and fails when GitHub refuses the token. A turn with neither an installation token nor a `GITHUB_TOKEN` is refused `RepositoryTokenRefused`. `doc/personas/ticket-worker` is a persona that works a GitHub issue.

- `tumpel config init <file>` writes a new file from the tenant's current state.
- `tumpel config validate <file>` prints every schema error with its JSON pointer.
- `tumpel config plan <file>` prints each create, update and delete without applying it.
- `tumpel config apply <file>` replaces the tenant's config with the file, all of it or nothing.

`apply` is a full replace. It writes everything the file describes and deletes whatever the file leaves out. The control plane checks every change first, then writes personas, secret sets, secret values and pins in one transaction of the tenant's database: a change that is refused leaves the tenant exactly as it was. Host labels live in the central database, so apply writes them after that commit. Apply checks every host before that commit; a host revoked while the apply runs is the one case that keeps the committed changes and leaves its labels unwritten.

Personas and secret sets match by name, pins by harness, hosts by `hostId`. Apply deletes whatever the file leaves out; an unlisted host loses its labels. Secret values are never read back. Secret values are decided once per request. With no values sent, every secret set the file keeps keeps its stored values, and a set the file creates or changes is refused for its missing values. With any value sent, the values must cover every variable the file names: every kept set is rewritten, and a value left out refuses the whole plan or apply before anything is written. The CLI sends what is exported, so export all of the variables or none. A rewritten set keeps its `secretSetId` and key names.

Plan and apply run on the control plane: `TenantConfigs_plan` takes the file with each persona file's digest and the exported variable names, and `TenantConfigs_apply` takes it with each file's bytes and the exported values. The CLI and the dashboard's setup checklist both call them. The CLI plans with the names it exports; the dashboard plans with an empty list, so its plan never shows a rewrite; the MCP tool `tumpel_config_apply` takes no secret values, so it applies a config whose secret sets are kept as they are, and refuses one that creates a secret set or changes its members.

## Set one value at a time

Every value of the file also has a command of its own, each value a flag or a `--file <path>`. A secret value is read from stdin with `--stdin`, one value per invocation, never as a flag value, and is never echoed. `set-member variable`, `set-member api-key` and `set-member subscription-token` each take the flags their kind needs; each replaces a member of the same name and keeps every other member's value. `remove-member` drops one. `persona update` takes at least one flag and keeps what its flags leave out; `--persona-file` replaces the whole file set.

```sh
tumpel secret-set create --name Default
gh auth token | tumpel secret-set set-member variable <secretSetId> --name GITHUB_TOKEN --stdin
tumpel secret-set set-member subscription-token <secretSetId> --name CLAUDE_CODE_OAUTH_TOKEN \
  --provider Anthropic --expires-at 2027-11-15T00:00:00+00:00 --stdin < token.txt
tumpel secret-set remove-member <secretSetId> ANTHROPIC_API_KEY
tumpel persona create --name tumpel-dev --harness ClaudeCode --secret-set-id <secretSetId> \
  --persona-file .claude/settings.json=./settings.json --persona-file .claude/CLAUDE.md=./CLAUDE.md
tumpel persona update <personaId> --secret-set-id <secretSetId>
tumpel harness pin ClaudeCode 2.0.0
tumpel host set-labels <hostId> gpu
```

`tumpel config plan` and `apply` keep reading secret values from the variables `valueFrom.env` names.

## Set up a tenant

`doc/personas/` holds `tumpel-dev.json` with the persona `tumpel-dev`, which works on this repository with Claude Code on Opus. Its secret set carries a Claude Code subscription token and a GitHub token. To apply it:

1. `tumpel login --endpoint <stage origin>`, such as `https://api.dev.tumpel.dev`.
2. Open the URL it prints in a browser and approve the code.
3. `npm run tenant:apply -- doc/personas/tumpel-dev.json`

`tenant:apply` reads the subscription token and its expiry from `~/.claude/.credentials.json` and the GitHub token from `gh auth token`, in process. It passes them to `tumpel config apply` through the environment only, so a rerun rotates the values. `TUMPEL_CREDENTIAL=dotfiles:<key name>` with `TUMPEL_CREDENTIAL_EXPIRES_AT` reads the token from dotfiles instead. Export any other secret the file names first. `--endpoint <url>` overrides the control plane the CLI env file names; it must be the control plane the CLI signed in to.
