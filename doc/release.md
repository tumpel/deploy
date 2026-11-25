# Release

Every component publishes its own releases. tumpel/deploy pins one release of each package in its own file under `pins/`, and each pin file starts only its own pipeline. `doc/deploy.md` covers the Workers Builds projects, the stage layout and bootstrap.

## Pins

| File                      | Holds                                        | Moved by                     | Deployed by                                  |
| ------------------------- | -------------------------------------------- | ---------------------------- | -------------------------------------------- |
| `pins/control-plane.json` | `{ "release": "rc.<N>", "commit": "<sha>" }` | the control-plane `bump` job | Workers Builds `tumpel`                      |
| `pins/dashboard.json`     | `{ "release": "<tag>", "commit": "<sha>" }`  | the dashboard `bump` job     | Workers Builds on `tumpel-dashboard-<stage>` |
| `pins/infra.json`         | `{ "commit": "<sha>" }`                      | a pull request               | Workers Builds `tumpel-infra`                |
| `pins/supervisor.json`    | `{ "release": "<X.Y.Z-rc.N>" }`              | a pull request               | `release.yml`, which writes `current.json`   |
| `pins/cli.json`           | `{ "release": "<X.Y.Z-rc.N>" }`              | a pull request               | `release.yml`, which writes `current.json`   |

`release` names the GitHub release whose artifact deploys, and `commit` is its source commit. Protocol tarballs are pinned by hand as `package.json` dependency URLs.

## Candidates and the bump

In tumpel/control-plane and tumpel/dashboard, every push to `main` that touches more than docs and passes its checks publishes the prerelease `rc.<N>`, where `N` is `git rev-list --count` of the commit. It carries the artifact and its `.sha256`, and a published release is never overwritten.

The `bump` job then runs `node npm-scripts/bump-pin.mjs <package> rc.<N>` from tumpel/deploy main with a token of the GitHub App `tumpel-release`. It verifies the release, reads the pin and the highest `N` among recent `chore(pins): deploy <package> rc.<N> to dev` commit subjects, and writes the pin with that subject unless the pin or that high-water mark already holds `N` or newer. A conflicting write rereads once. A late older candidate and a rerun after a revert write nothing.

## Pipelines

- Back end: `npm run deploy:code` downloads `control-plane-rc.<N>.tgz`, checks its sha256, refuses an archive whose last Durable Object migration tag is older than the deployed Worker's, applies D1 migrations, upserts the dashboard OAuth client and deploys `tumpel-control-plane-<stage>` with `DEPLOYED_COMMIT` from the pin.
- Front end: `npm run deploy:dashboard` downloads the dashboard tarball, checks its sha256, writes the stage's API origin into `index.html`, adds `packages/dashboard-site/_headers` and deploys the assets-only Worker `tumpel-dashboard-<stage>`.
- Infra: `npm run deploy:infra` applies the pinned tumpel/infra commit.
- Supervisor and CLI: `.github/workflows/release.yml` runs on a push to `main` that changes `pins/supervisor.json` or `pins/cli.json`, and by hand for another stage. `layers` builds and uploads missing harness layers. `publish` downloads the pinned supervisor and CLI, checks their sha256 and writes `current.json` with `releaseVersion` `0.0.0-<12-char commit>`. It refuses an RC pin outside `dev`, a supervisor whose protocol windows miss this commit's or the images', and a missing harness layer. It leaves `current.json` unchanged when that already holds a descendant of this commit.

The back end and the front end deploy in whatever order their merges land. A breaking change across them is ordered by hand.

## The release manifest

`current.json` in `tumpel-releases-<stage>` is a `ReleaseManifest` (`typespec/lib/release.tsp` in tumpel/protocol), and `release.yml` is its only writer. Every other object except `images.json` sits under its digest. The control plane serves it at `GET /v1/releases/current`, and a write raises ReleasePublished to every Online host.

A supervisor updates when the sha256 for its architecture differs from its own binary. It refuses an older version unless the manifest carries `rollback: true`. `publish` sets `rollback` when the pinned supervisor is older than the published one, keeps it while the pin stays, and clears it on an upgrade. `doc/EDD/008-supervisor-self-update.md` covers the swap.

## Guest images

`.github/workflows/images.yml` runs on a tag `images-vX.Y.Z`, builds the guest and base images from the pinned supervisor's guest and writes `images.json`. They go live at the next `current.json`.

## Rolling back

Revert the pin commit on tumpel/deploy `main`. Only that package's pipeline runs, and it redeploys the previous release. The next merge in that repository bumps the pin again, so fix forward or revert there too. D1 migrations stay applied, and tumpel/control-plane's migration check refuses a contract migration without review. The back end refuses to cross a Durable Object migration. A supervisor revert publishes `rollback: true`.

## End-to-end proof

`npm run proof:e2e` proves a stage after a deploy (`doc/EDD/006-end-to-end-proof.md`). A person runs it from a checkout against the KVM host `TUMPEL_PROOF_HOST`; `doc/deploy.md` lists its credentials.

## Known gaps

1. `dev` is the only stage.
2. Supervisor and CLI pins move by hand.
3. Protocol tarballs are pinned by hand.
