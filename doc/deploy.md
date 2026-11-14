# Deploy

The control plane deploys per stage; the stage is `TUMPEL_STAGE` and defaults to `dev`. The `dev` stage runs at https://tumpel-control-plane-dev.matthijs-f49.workers.dev.

A stage is a wrangler environment of the same name in `packages/control-plane/wrangler.jsonc`, which repeats the bindings, vars and Durable Object migrations because wrangler does not inherit them, and one OpenTofu state, `tumpel-<stage>.tfstate` in `tumpel-tfstate`. Account-wide resources carry the stage: the Worker `tumpel-control-plane-<stage>`, the R2 bucket `tumpel-sessions-<stage>`, the Access application `tumpel browser pages <stage>` and its policy. The D1 database is named `tumpel-<stage>` when a stage creates it; `dev` adopted the original database, still named `tumpel`, and OpenTofu ignores later name changes. To add a stage, add its `env` block, run `TUMPEL_STAGE=<stage> npm run deploy:infra`, copy the printed `database_id` into that block, and deploy.

The account token is `tumpel-tofu`. It carries Access: Apps and Policies Write, Access: Policies Write, Access: Organizations, Identity Providers, and Groups Read, Account Settings Read, D1 Write, Workers Scripts Write and Workers R2 Storage Write. To add a permission group, PUT the token by id with the group appended, using the account's token-minting key; the token value stays the same. OpenTofu keeps its state in the R2 bucket `tumpel-tfstate`, reached with the `tumpel-tfstate` token as S3 keys. Both are stored in dotfiles as `tumpel-tofu-token` and `tumpel-tfstate-s3`. `~/.config/tumpel/cf-env` (mode 600) holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TFSTATE_ACCESS_KEY_ID`, `TFSTATE_SECRET_ACCESS_KEY` and `TUMPEL_APPROVER_EMAILS` (a JSON list).

Bootstrap order on a new account:

1. Mint `tumpel-tofu` and `tumpel-tfstate` from the account's token-minting key, create `tumpel-tfstate`, and write `cf-env`.
2. `npm run deploy:infra` applies `packages/control-plane/infra/`: the D1 database `tumpel`, the R2 bucket `tumpel-sessions-<stage>` (transcript chunks and snapshots), and the Access application `tumpel browser pages <stage>`, which puts `/device`, `/v1/tenants`, `/v1/device/approve`, `/v1/device/deny` and `/oauth/consent` behind the one-time PIN.
3. Copy the `database_id` it prints into the stage's `env` block of `packages/control-plane/wrangler.jsonc` and commit.
4. Presigned snapshot URLs need an R2 API token with Object Read & Write on `tumpel-sessions-<stage>` only. Create it in the dashboard under R2, Manage API tokens, then set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` with `wrangler secret put <name> --env <stage>` from the package directory, typing each value on stdin. None of the tokens kept locally can create tokens.
5. Create an R2 API token with Object Read & Write on `tumpel-sessions` only, and put its S3 key pair on the Worker: `wrangler secret put R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` from `packages/control-plane`. The Worker signs short-lived snapshot upload and download URLs with it; hosts never hold a storage key.

The Worker reads its turn budgets, snapshot delay and deadline, dispatch grant lifetime and transcript chunk size from the `TUMPEL_SETTINGS` var in `wrangler.jsonc`, checked against `ControlPlaneSettings` in `packages/api/models.tsp`.

Commands:

- `npm run deploy` applies the infra of the stage, refuses a plan that destroys anything, applies D1 migrations and deploys the Worker with `ACCESS_ISSUER` and `ACCESS_AUD` taken from the tofu outputs.
- `npm run deploy:migrate` applies D1 migrations only.

Sign a terminal in with `tumpel login --endpoint https://tumpel-control-plane-dev.matthijs-f49.workers.dev`.
