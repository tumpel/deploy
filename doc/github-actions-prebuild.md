# GitHub Actions prebuilds

A tenant connects GitHub Actions with `tumpel github-actions start --account-label <label> --caller-workflow .github/workflows/tumpel-prebuild.yml`. Each prebuild start commits that caller workflow to the repository's default branch through the GitHub App when it is missing or differs from the example below, so no one commits it by hand. `tumpel github-actions get` answers the same text as `callerWorkflowExample`, and the reusable workflow it calls as `reusableWorkflow`.

```yaml
name: tumpel prebuild

on:
  workflow_dispatch:
    inputs:
      prebuildId:
        description: The prebuild Tumpel started
        required: true
        type: string
      tenantId:
        description: The tenant that started the prebuild
        required: true
        type: string
      apiOrigin:
        description: The Tumpel API the upload job calls
        required: true
        type: string
      rootfsUrl:
        description: A presigned GET of the guest image's root filesystem tar
        required: true
        type: string
      imageDigest:
        description: The digest of the guest image the layer is built on
        required: true
        type: string

permissions:
  contents: read
  id-token: write

jobs:
  prebuild:
    uses: tumpel/workflows/.github/workflows/prebuild.yml@v1
    with:
      prebuildId: ${{ inputs.prebuildId }}
      tenantId: ${{ inputs.tenantId }}
      apiOrigin: ${{ inputs.apiOrigin }}
      rootfsUrl: ${{ inputs.rootfsUrl }}
      imageDigest: ${{ inputs.imageDigest }}
```

A prebuild start reads its inputs from the head commit of the default branch. It reads the caller workflow there and, when it is missing or differs, commits the example on top of that head with the App installation token. GitHub dispatches only a workflow on the default branch, so the commit lands before the dispatch, and the prebuild records the new commit as its head. A branch that moved between the read and the commit refuses the start `CallerWorkflowRefused`. It then dispatches the caller workflow on that branch, with these inputs:

| Input         | Value                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `prebuildId`  | The prebuild the start recorded                                                                    |
| `tenantId`    | The tenant that started it                                                                         |
| `apiOrigin`   | The API origin the upload job calls and names as the token's `aud`                                 |
| `rootfsUrl`   | A presigned GET of the guest image's root filesystem tar, valid for the dispatch and build budgets |
| `imageDigest` | The digest of the guest image the layer is built on                                                |

The dispatch needs the GitHub App's Actions write permission, and the commit needs Contents and Workflows write. The installation token names what the installation granted; a start that lacks one is refused `GitHubAppPermissionMissing` before anything is committed, naming each missing permission. A changed App manifest does not update an existing App: the App owner adds the permission in the App's settings, and each installation accepts it.

`rootfsUrl` reads `images/<harness>/<version>/amd64/rootfs/<diff_id>` from the releases bucket.

## Runs

The dispatch is POST `/repos/<owner>/<name>/actions/workflows/<caller workflow file>/dispatches` with `return_run_details`. The prebuild records the run id and the head commit in `prebuild_runs` (tenant migration 0026). The control plane refuses a start `GitHubNotConnected` while no App installation links the tenant. When GitHub refuses the installation token or the dispatch, the start fails `DispatchRefused`.

The App webhook follows the `workflow_run` events of a Dispatched or Building prebuild:

| Event                                            | Prebuild                                                    |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `in_progress` on the recorded commit             | Building                                                    |
| `in_progress` on another commit                  | Failed in phase Dispatch                                    |
| `completed` without success                      | Failed in phase Build, with the run's `html_url` as the log |
| `completed` with success and no completed upload | Failed in phase Upload                                      |

An upload start from the recorded run also moves a Dispatched prebuild to Building, with the same commit check.

A run that is not `in_progress` within `prebuildDispatchBudgetSeconds` (600) fails the prebuild in phase Dispatch. A prebuild still Building after `prebuildBuildBudgetSeconds` (3600) fails in phase Build, or in phase Upload once its upload started.

## Workflow

The reusable workflow `tumpel/workflows/.github/workflows/prebuild.yml` runs two jobs:

- `build` holds `contents: read` and no `id-token`. A repository without a devcontainer.json builds with the default config, which installs the dependencies of each stack `prebuild.mjs` detects. It imports the root filesystem tar as a local `linux/amd64` image, checks the repository out without credentials, bind-mounts it at `/root/workspace`, runs `/opt/tumpel/prebuild.mjs build /out` in the container and keeps `/out` as a job artifact.
- `upload` holds `id-token: write` and runs no repository code. It extracts `/opt/tumpel/prebuild.mjs` and the image's Node.js from the same root filesystem tar, never from the artifact, and runs `prebuild.mjs upload` with the artifact.

The upload job's token must carry a `job_workflow_ref` of `tumpel/workflows/.github/workflows/prebuild.yml` at tag `v1` or at a release tag `v1.x.y`; the upload start refuses any other with `JobTokenMismatch` on `job_workflow_ref`. A caller that pins a commit SHA is refused too, because its `job_workflow_ref` names no tag.

The build and upload jobs run `/opt/tumpel/prebuild.mjs` from the guest image the prebuild names, and `v1` moves with each change to tumpel/workflows. `prebuild.yml` must therefore stay compatible with every guest image still published, not only the newest. Step 16 of the proof runs its fixture through `@v1`, so it exercises the copy callers get.

## Maintaining tumpel/workflows

[tumpel/workflows](https://github.com/tumpel/workflows) is the source of `prebuild.yml` and of the caller example `examples/tumpel-prebuild.yml`. The workflows move at their own pace, so they live in their own repository. Agents commit there like in any other repository, tag the commit with the next immutable `vX.Y.Z` and move `v1` to it once the change is ready. Skew between the workflow and the API is handled case by case in the change that causes it.

The five inputs are declared in each tenant's caller workflow, which Tumpel dispatches and which passes them on to `prebuild.yml`. Adding, renaming or removing an input therefore changes the caller contract: every tenant must update its caller workflow, so the control plane's `DISPATCH_INPUTS` in `packages/control-plane/src/github-actions.ts`, `on.workflow_call.inputs` in `prebuild.yml` and the caller workflow above change together.
