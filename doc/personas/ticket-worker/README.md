# ticket-worker persona

A Claude Code persona that works one GitHub issue and opens a draft pull request. Its box clones the session's repository with the `GITHUB_TOKEN` member of its secret set; `gh` reads the same token as `GH_TOKEN`. Claude Code already runs with permissions skipped in the image, and `settings.json` keeps it that way. `CLAUDE.md` holds the house rules for a ticket.

Add these entries to your tenant config file, with `from` relative to that file, then run `tumpel config apply <file>`:

```json
{
  "personas": [
    {
      "name": "ticket-worker",
      "harness": "ClaudeCode",
      "secretSetName": "ticket-worker",
      "gitAuthorName": "Tumpel Ticket Worker",
      "gitAuthorEmail": "ticket-worker@users.noreply.github.com",
      "files": [
        { "path": ".claude/settings.json", "from": "doc/personas/ticket-worker/settings.json" },
        { "path": ".claude/CLAUDE.md", "from": "doc/personas/ticket-worker/CLAUDE.md" }
      ]
    }
  ],
  "secretSets": [
    {
      "name": "ticket-worker",
      "secrets": [
        {
          "kind": "SubscriptionToken",
          "name": "CLAUDE_CODE_OAUTH_TOKEN",
          "provider": "Anthropic",
          "expiresAt": "2027-11-14T00:00:00+00:00",
          "valueFrom": { "env": "TICKET_WORKER_CLAUDE_CODE_OAUTH_TOKEN" }
        },
        {
          "kind": "Variable",
          "name": "GITHUB_TOKEN",
          "valueFrom": { "env": "TICKET_WORKER_GITHUB_TOKEN" }
        }
      ]
    }
  ]
}
```

Set `expiresAt` to the expiry of the token `claude setup-token` printed; with an Anthropic API key, use an `ApiKey` member named `ANTHROPIC_API_KEY` instead. `GITHUB_TOKEN` is a fine-grained token with read and write access to contents and pull requests of the repositories the persona works on. Export both variables before `apply`; the values never go in the file.

Work an issue from a signed-in terminal:

```sh
npm run ticket -- https://github.com/acme/app/issues/12 --persona ticket-worker --model claude-opus-4-5 [--endpoint https://<your tumpel host>]
```

It reads the issue with `gh issue view`, starts a session on the issue's repository, streams the turn's lines, and prints the pull request URL. A failed turn exits non-zero with its failure reason.
