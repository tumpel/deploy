# GitHub Actions prebuilds

A tenant connects GitHub Actions with `tumpel github-actions start --account-label <label> --caller-workflow .github/workflows/tumpel-prebuild.yml`. Each prebuild start commits that caller workflow to the repository's default branch through the GitHub App when it is missing or differs from the example below, so no one commits it by hand. `tumpel github-actions get` answers the same text as `callerWorkflowExample`, and the reusable workflow it calls as `reusableWorkflow`. The example names the repository's default branch, the connection's path and the API origin of the stage, set at deploy as `API_ORIGIN`. The connection shows it with `main` as the branch:

```yaml
name: tumpel prebuild

on:
  push:
    branches:
      - main
    paths:
      - .github/workflows/tumpel-prebuild.yml
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  prebuild:
    uses: tumpel/workflows/.github/workflows/prebuild.yml@v2
    with:
      apiOrigin: https://api.tumpel.dev
```

## Start

A prebuild start mints the App installation token, reads the default branch, then reads the caller workflow and the inputs at the branch's head:

- When the caller workflow is missing or stale, the start commits the example on the branch. The push of that commit starts the run, because the workflow triggers on a push to its own path. The commit changes no input, so the start records a new prebuild against the new commit with the inputs it read.
- When it is current, a prebuild with the same key that is not Failed answers the start, unless it asks for a rebuild. Otherwise the start dispatches the caller workflow on the branch with no inputs and records the prebuild against the head it read.

The start holds the tenant only while it commits or dispatches and records, so a run that asks for its inputs early waits for the record. The prebuild's log points at the workflow's runs until a run takes it.

The commit needs the GitHub App's Contents and Workflows write permission, and the dispatch needs Actions write. The installation token names what the installation granted; a start that lacks one is refused `GitHubAppPermissionMissing` before anything is committed, naming each missing permission. A changed App manifest does not update an existing App: the App owner adds the permission in the App's settings, and each installation accepts it.

| Refusal                      | Cause                                                       | Fix                                                                    |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GitHubNotConnected`         | No App installation of the tenant covers the owner          | Install the App with `tumpel github start`                             |
| `DispatchRefused`            | GitHub refused the installation token                       | Unsuspend the App installation or give it access to the repository     |
| `GitHubAppPermissionMissing` | The installation lacks Actions, Contents or Workflows write | Accept the new permissions on GitHub                                   |
| `CallerWorkflowRefused`      | GitHub refused the commit, such as on a protected branch    | Let the App push to the branch, or commit the example by hand          |
| `DispatchRefused`            | Actions are disabled in the repository or for the workflow  | Allow actions and reusable workflows, and enable the workflow          |
| `DispatchRefused`            | GitHub refused the dispatch for another reason              | Fix what GitHub's answer names; a 5xx is an outage on githubstatus.com |

## Runs

A run is picked up by the commit the prebuild recorded, whichever event started it. The first of these takes the newest Dispatched prebuild of the repository at the run's commit and records the run id:

- the run's call to `POST /v1/prebuild-inputs`, which also moves the prebuild to Building;
- a `workflow_run` event of the connection's caller workflow at that commit.

The App webhook then follows the `workflow_run` events of the run:

| Event                                            | Prebuild                                                    |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `in_progress`                                    | Building                                                    |
| `completed` without success                      | Failed in phase Build, with the run's `html_url` as the log |
| `completed` with success and no completed upload | Failed in phase Upload                                      |

A run that is not picked up within `prebuildDispatchBudgetSeconds` (600) fails the prebuild in phase Dispatch. A prebuild still Building after `prebuildBuildBudgetSeconds` (3600) fails in phase Build, or in phase Upload once its upload started.

`POST /v1/prebuild-inputs` takes the job's OIDC token for the API origin and answers `prebuildId`, `tenantId`, `rootfsUrl` and `imageDigest`. `rootfsUrl` is a presigned GET of `images/<harness>/<version>/amd64/rootfs/<diff_id>` in the releases bucket, valid for the dispatch and build budgets. A run at a commit no prebuild waits for, such as the push of a hand-edited caller workflow, is refused `NotFound`.

## Workflow

The reusable workflow `tumpel/workflows/.github/workflows/prebuild.yml` runs three jobs:

- `inputs` holds `id-token: write` and runs no repository code. It requests the job's OIDC token for `apiOrigin`, calls `POST /v1/prebuild-inputs` and hands the answer to the other jobs.
- `build` holds `contents: read` and no `id-token`. A repository without a devcontainer.json fails the build with DevcontainerMissing. It imports the root filesystem tar as a local `linux/amd64` image, checks the repository out without credentials, bind-mounts it at `/root/workspace`, runs `/opt/tumpel/prebuild.mjs build /out` in the container and keeps `/out` as a job artifact.
- `upload` holds `id-token: write` and runs no repository code. It extracts `/opt/tumpel/prebuild.mjs` and the image's Node.js from the same root filesystem tar, never from the artifact, and runs `prebuild.mjs upload` with the artifact.

Every token the run presents must carry a `job_workflow_ref` of `tumpel/workflows/.github/workflows/prebuild.yml` at tag `v2` or at a release tag `v2.x.y`, and an `event_name` of `push` or `workflow_dispatch`; any other is refused `JobTokenMismatch`. A caller that pins a commit SHA is refused too, because its `job_workflow_ref` names no tag.

The build and upload jobs run `/opt/tumpel/prebuild.mjs` from the guest image the prebuild names, and `v2` moves with each change to tumpel/workflows. `prebuild.yml` must therefore stay compatible with every guest image still published, not only the newest. Step 16 of the proof runs its fixture through `@v2`, so it exercises the copy callers get.

## Maintaining tumpel/workflows

[tumpel/workflows](https://github.com/tumpel/workflows) is the source of `prebuild.yml` and of the caller example `examples/tumpel-prebuild.yml`. The workflows move at their own pace, so they live in their own repository. Agents commit there like in any other repository, tag the commit with the next immutable `vX.Y.Z` and move the major tag to it once the change is ready. Skew between the workflow and the API is handled case by case in the change that causes it.

The caller workflow passes only `apiOrigin`; every other input comes from `POST /v1/prebuild-inputs`. A change to that answer changes `prebuild.yml` and the control plane together, and leaves the callers alone. A change to the caller's own inputs needs a new major tag: `REUSABLE_WORKFLOW` in `packages/control-plane/src/github-actions.ts` moves to it, and the next start of each repository commits the new caller workflow.
