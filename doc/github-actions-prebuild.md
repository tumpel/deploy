# GitHub Actions prebuilds

A tenant connects GitHub Actions with `tumpel github-actions start --account-label <label> --caller-workflow .github/workflows/tumpel-prebuild.yml`. Each repository it prebuilds then holds that caller workflow on its default branch. `tumpel github-actions get` answers the same text as `callerWorkflowExample`.

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
    uses: mvhenten/tumpel/.github/workflows/prebuild.yml@main
    with:
      prebuildId: ${{ inputs.prebuildId }}
      tenantId: ${{ inputs.tenantId }}
      apiOrigin: ${{ inputs.apiOrigin }}
      rootfsUrl: ${{ inputs.rootfsUrl }}
      imageDigest: ${{ inputs.imageDigest }}
```

A prebuild start dispatches the caller workflow on the default branch through the GitHub App, with these inputs:

| Input         | Value                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `prebuildId`  | The prebuild the start recorded                                                                    |
| `tenantId`    | The tenant that started it                                                                         |
| `apiOrigin`   | The API origin the upload job calls and names as the token's `aud`                                 |
| `rootfsUrl`   | A presigned GET of the guest image's root filesystem tar, valid for the dispatch and build budgets |
| `imageDigest` | The digest of the guest image the layer is built on                                                |

The dispatch needs the GitHub App's `actions: write` permission. A changed App manifest does not update an existing App: the App owner adds the permission in the App's settings, and each installation accepts it.

The reusable workflow `.github/workflows/prebuild.yml` runs two jobs:

- `build` holds `contents: read` and no `id-token`. It imports the root filesystem tar as a local `linux/amd64` image, checks the repository out without credentials, bind-mounts it at `/root/workspace`, runs `/opt/tumpel/prebuild.mjs build /out` in the container and keeps `/out` as a job artifact.
- `upload` holds `id-token: write` and runs no repository code. It extracts `/opt/tumpel/prebuild.mjs` and the image's Node.js from the same root filesystem tar, never from the artifact, and runs `prebuild.mjs upload` with the artifact.

The repository holding `prebuild.yml` stays private for now, so only repositories of its owner's account can call it, once its Actions settings allow access from repositories owned by the user.
