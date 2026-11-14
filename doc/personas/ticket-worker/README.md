# ticket-worker persona

A Claude Code persona that works one GitHub issue and opens a draft pull request. Its box clones the session's repository with the `GITHUB_TOKEN` member of its secret set; `gh` reads the same token as `GH_TOKEN`. Claude Code already runs with permissions skipped in the image, and `settings.json` keeps it that way. `CLAUDE.md` holds the house rules for a ticket.

The persona and its secret set live in [`doc/personas/proof-tenant.json`](../proof-tenant.json), the one tenant config of the proof tenant, next to the `proof` and `refused` personas of `npm run proof:e2e`. Both scripts apply that file before they start a session, and apply deletes whatever it leaves out, so a persona for the proof tenant goes into that file. Every secret value comes from the environment: `npm-scripts/proof-tenant.mjs` loads the subscription token from the dotfiles key `claude-setup-token-personal` (or `TUMPEL_PROOF_CREDENTIAL`) and `GITHUB_TOKEN` from `gh auth token` in process.

Set `expiresAt` to the expiry of the token `claude setup-token` printed. `GITHUB_TOKEN` needs read and write access to contents and pull requests of the repositories the persona works on.

Work an issue from a signed-in terminal:

```sh
npm run ticket -- <issue url> --persona ticket-worker --model <model> [--endpoint <url>]
```

It reads the issue with `gh issue view`, applies the proof tenant config, starts a session on the issue's repository, streams the turn's lines, and prints the pull request URL. `--model` is required: the catalog pins the harness version, and the start names the model. A failed turn exits non-zero with its failure reason.
