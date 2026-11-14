# Deploy

The control plane runs at https://tumpel-control-plane.matthijs-f49.workers.dev, deployed by hand from the main checkout.

The account token is `tumpel-tofu`; OpenTofu keeps its state in the R2 bucket `tumpel-tfstate`, reached with the `tumpel-tfstate` token as S3 keys. Both are stored in dotfiles as `tumpel-tofu-token` and `tumpel-tfstate-s3`. `~/.config/tumpel/cf-env` (mode 600) holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TFSTATE_ACCESS_KEY_ID`, `TFSTATE_SECRET_ACCESS_KEY` and `TUMPEL_APPROVER_EMAILS` (a JSON list).

Bootstrap order on a new account:

1. Mint `tumpel-tofu` and `tumpel-tfstate` from the account's token-minting key, create `tumpel-tfstate`, and write `cf-env`.
2. `npm run deploy:infra` applies `packages/control-plane/infra/`: the D1 database `tumpel` and the Access application `tumpel browser pages`, which puts `/device`, `/v1/tenants`, `/v1/device/approve`, `/v1/device/deny` and `/oauth/consent` behind the one-time PIN.
3. Copy the `database_id` it prints into `packages/control-plane/wrangler.jsonc` and commit.

Commands:

- `npm run deploy` applies the infra, refuses a plan that destroys anything, applies D1 migrations and deploys the Worker with `ACCESS_ISSUER` and `ACCESS_AUD` taken from the tofu outputs.
- `npm run deploy:migrate` applies D1 migrations only.

Sign a terminal in with `tumpel login --endpoint https://tumpel-control-plane.matthijs-f49.workers.dev`.
