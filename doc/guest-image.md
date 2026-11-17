# Guest image

`npm run guest:build` builds `tumpel-guest` as a static binary for `TUMPEL_TARGET`, by default `x86_64-unknown-linux-gnu`. `npm run guest:image -- <harness> [amd64|arm64]` then builds a read-only ext4 rootfs without root, for `ClaudeCode` from the harness catalog, `Shell` for tests, or `all` for both, for the given architecture, by default the build machine's. It refuses arm64 unless `BUILD_ARM64=true`. It writes `<digest>.ext4`, `<digest>.json` (`GuestImageManifest`) and `<kernelDigest>.vmlinux` to `$TUMPEL_IMAGE_DIR`, by default `~/development/.tmp/tumpel-images`.

The build:

1. Downloads the Firecracker CI Ubuntu 24.04 squashfs and kernel, the Ubuntu `git` and `libcurl3t64-gnutls` packages, the Ubuntu packages listed in `npm-scripts/guest-packages.mjs` (written by `npm run guest:packages -- <arch> <base rootfs squashfs>`, which resolves them against the base), the GitHub CLI `gh`, the Node LTS runtime, `fnm`, `uv` and `rustup-init`, each checked against the digest pinned in `npm-scripts/guest-image.mjs`.
2. Unpacks the squashfs with `unsquashfs`, unpacks the packages with `dpkg-deb -x` and `gh` into `/usr/local/bin`, installs the tooling under Preinstalled tooling, running the build machine's own `uv` and `rustup-init` to fetch Python and the Rust toolchain, adds `tumpel-guest`, its systemd unit, `/usr/local/sbin/tumpel-init` and `/etc/tumpel/guest.json` (`GuestHarness`), and runs `npm install` for the linux platform package of the catalog's pinned Claude Code release, whose native `claude` binary is the harness command.
3. Packs the tree with `mkfs.ext4 -d` and sets every inode to root with `debugfs`.

In the box, `tumpel-init` mounts the second drive as the overlay upper directory and formats it on first boot. It then pivots into the overlay and starts systemd. `tumpel-guest` listens on vsock port 1024 and announces itself on host port 1025. It keeps one harness process per box and starts it with the turn's provider key in the environment variable `providerKeyName` in `guest.json` names. A turn whose key or model differs from the running process's restarts the harness, continuing the conversation. The key is never written to the guest disk or logged. Before the harness starts, the guest clones the turn's `repository` into the empty harness working directory, `/root/workspace`, at its default branch; git reads `GITHUB_TOKEN` from the environment through a credential helper set in `GIT_CONFIG_*` variables, and `gh` reads it as `GH_TOKEN`. A directory that already holds a repository, on a resumed or restored box, is left as it is.

## Preinstalled tooling

Every image, the base included, ships this tooling for root, the user the harness runs as. The harness `PATH` is `/root/.local/share/fnm/aliases/default/bin:/root/.cargo/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, so every command below runs in a non-interactive shell without sourcing a profile. Agents use these and never install them again.

| Tool                                                                                               | Version                                                  | Where                                                                                                         |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `gcc`, `g++`, `cc`, `c++`, `make`, `libc6-dev`, `dpkg-dev` (Ubuntu `build-essential`)              | GCC 13.3, Make 4.3                                       | `/usr/bin`                                                                                                    |
| `pkg-config` (`pkgconf`)                                                                           | 1.8.1                                                    | `/usr/bin`                                                                                                    |
| `git`                                                                                              | 2.43.0                                                   | `/usr/bin`                                                                                                    |
| `gh`                                                                                               | 2.103.3                                                  | `/usr/local/bin`                                                                                              |
| `curl`, `ca-certificates`                                                                          | from the Ubuntu 24.04 base                               | `/usr/bin`, `/etc/ssl/certs`                                                                                  |
| `jq`, `unzip`, `zip`, `rg` (ripgrep), `fd` (also `fdfind`), `tree`, `xz`, `bzip2`, `patch`, `perl` | Ubuntu 24.04                                             | `/usr/bin`                                                                                                    |
| `fnm`                                                                                              | 1.39.0                                                   | `/root/.local/bin`                                                                                            |
| `node`, `npm`, `npx` (Node LTS, the fnm default)                                                   | 26.13.1                                                  | `/root/.local/share/fnm/aliases/default/bin`, hard-linked at `/opt/tumpel/node/bin` for the prebuild workflow |
| `uv`, `uvx`                                                                                        | 0.13.8                                                   | `/root/.local/bin`                                                                                            |
| `python`, `python3`, `python3.15` (uv-managed CPython)                                             | 3.15.2                                                   | `/root/.local/bin`, installed under `/root/.local/share/uv/python`                                            |
| `rustup`, `cargo`, `rustc`, `cargo clippy`, `rustfmt` (profile `minimal`)                          | 1.100.0, `RUST_VERSION` in `npm-scripts/guest-image.mjs` | `/root/.cargo/bin`, toolchains under `/root/.rustup`                                                          |

`fnm install` and `fnm default` switch the Node on `PATH`, `uv python install` adds Pythons, and `rustup toolchain install` adds Rust toolchains; each writes to the box's overlay disk, not the image. A repository's prebuild adds only what that repository needs on top of this set.

Building an image needs `unzip` on the build machine besides the tools under Host prerequisites. The tooling adds about 1.3 GB to the image tree, the Rust toolchain 653 MB, the Node and Python runtimes about 330 MB and the Ubuntu packages about 310 MB, and grows the base's ext4 from 943 MB to 2,633 MB. Harness layers carry no tooling; they sit over the base. A host downloads the base as that uncompressed ext4, so a host that fetches a new base moves its full size, about 2.6 GB, plus the 28 MB kernel and the harness layer, within `turnImageFetchBudgetSeconds` (900 seconds) for all three together. That needs at least 3 MB/s, about 24 Mbit/s, from the host to the release bucket; a slower host fails the turn `ImageFetchTimedOut`. Firecracker attaches the ext4 as a read-only block device and reads it on demand, so boot reads only the blocks it touches.

## Guest drive

`npm run guest:drive` packs the built `tumpel-guest`, its systemd unit, the guest drive's `init` and `base-layout` (`BaseLayout.Version`) into `.tmp/guest-drive/<TUMPEL_TARGET>.squashfs` with `mksquashfs -comp zstd -all-root -all-time 0 -mkfs-time 0`, so one guest binary yields one digest. `npm run supervisor:build` and `npm run release:build` build the guest, pack the drive and embed it in the supervisor through `TUMPEL_GUEST_DRIVE`; a release build without it fails. A debug build carries no drive. At start the supervisor writes its drive to `<imageCacheDir>/guest/<sha256>.squashfs`, deletes every other file there, and exits `GuestDriveUnwritable`, code 8, when it cannot within 60 seconds.

The guest drive's `init` runs from the base's stub init, with the drive mounted at `/opt/tumpel/guest`. It fails `base-layout` unless the base's `/etc/tumpel/base-layout` holds the drive's `base-layout`, then mounts the stack of EDD-007. It reads the harness mount point from `tumpel.harness=<harness>/<version>` on the kernel command line, needs `/opt/harness`, `/opt/tumpel/guest`, `/run`, `/mnt`, `/rom` and `/overlay` in the base, and enables the unit from a tmpfs at `/run/systemd/system`. Boxes boot from the drive only once the supervisor attaches it (EDD-007 stage 5).

The vsock protocol is length-prefixed JSON: a 4-byte big-endian length, then one `GuestMessage` from the guest or one `GuestTurnStart` from the host, as `supervisor.tsp` defines them.

## Host prerequisites

- `/dev/kvm` readable by the supervisor's user (group `kvm`), and Firecracker v1.18.0 at `firecrackerPath` in `runtime.json` (`SupervisorRuntime`). Firecracker runs unjailed as that user.
- A pool of `boxCapacity` TAP devices owned by that user, made once by `tumpel-supervisor install` (see `test-host.md`). Device `tumpel<k>` is a TAP with host address 172.16.<k>.1/30 and IPv4 masquerade, made by systemd-networkd or, without networkd, by `tumpel-tap-pool.service`, and its guest takes 172.16.<k>.2/30. The supervisor never needs `CAP_NET_ADMIN`. Egress is open to the internet; private and link-local destinations are dropped.
- `unsquashfs`, `mkfs.ext4`, `debugfs`, `e2fsck` and `dpkg-deb` on the machine that builds images, and `mksquashfs` 4.6 on the machine that builds the supervisor.

The host test runs a Shell box through boot, a turn, a snapshot, resume and a second turn:

```sh
TUMPEL_KVM=1 TUMPEL_IMAGE_MANIFEST=<cache>/<digest>.json cargo test -p tumpel-supervisor --features host-tests -- --nocapture
```
