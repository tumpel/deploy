# The ticket-worker persona

A Claude Code persona that works one GitHub issue and opens a draft pull request. Its box clones the session's repository with the `GITHUB_TOKEN` member of its secret set; `gh` reads the same token as `GH_TOKEN`. Claude Code already runs with permissions skipped in the image, and `settings.json` keeps it that way. `CLAUDE.md` holds the house rules for a ticket.

The persona and its secret set live in [`doc/personas/proof-tenant.json`](../proof-tenant.json), the one tenant config of the proof tenant, next to the `proof` and `refused` personas. `npm run proof:e2e` applies that file through `npm-scripts/proof-tenant.mjs`. Apply deletes whatever the file leaves out, so every persona of the proof tenant goes into that file. The file names an environment variable for every secret value and for the token's expiry. The script sets them: the subscription token and its expiry from the host Claude Code credential, or the source `TUMPEL_PROOF_CREDENTIAL` names as `doc/deploy.md` describes, and `GITHUB_TOKEN` from `gh auth token`.

A dotfiles key holds only the token, so its expiry goes in `TUMPEL_PROOF_CREDENTIAL_EXPIRES_AT`. `GITHUB_TOKEN` needs read and write access to contents and pull requests of the repositories the persona works on.

Work an issue from a signed-in terminal:

```sh
npm run ticket -- <issue url> --persona ticket-worker --model <model> [--endpoint <url>]
```

It reads the issue with `gh issue view`, checks that the tenant has the persona, starts a session on the issue's repository, streams the turn's lines, and prints the pull request URL. `--model` is required: the catalog pins the harness version, and the start names the model. A failed turn exits non-zero with its failure reason. Without the persona, it exits with the advice to apply the tenant config first.
