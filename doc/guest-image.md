# Guest image

`npm run guest:build` builds `tumpel-guest` as a static binary for `TUMPEL_TARGET`, by default `x86_64-unknown-linux-gnu`. `npm run guest:image -- <harness> [amd64|arm64]` then builds a read-only ext4 rootfs without root, for `ClaudeCode` from the harness catalog, `Shell` for tests, or `all` for both, for the given architecture, by default the build machine's. It refuses arm64 unless `BUILD_ARM64=true`. It writes `<digest>.ext4`, `<digest>.json` (`GuestImageManifest`) and `<kernelDigest>.vmlinux` to `$TUMPEL_IMAGE_DIR`, by default `~/development/.tmp/tumpel-images`.

The build:

1. Downloads the Firecracker CI Ubuntu 24.04 squashfs and kernel, the Ubuntu `git` and `libcurl3t64-gnutls` packages, the GitHub CLI `gh`, and for Claude Code the Node runtime, each checked against the digest pinned in `npm-scripts/guest-image.mjs`.
2. Unpacks the squashfs with `unsquashfs`, unpacks the packages with `dpkg-deb -x` and `gh` into `/usr/local/bin`, adds `tumpel-guest`, its systemd unit, `/usr/local/sbin/tumpel-init` and `/etc/tumpel/guest.json` (`GuestHarness`), and runs `npm install` for the linux platform package of the catalog's pinned Claude Code release, whose native `claude` binary is the harness command.
3. Packs the tree with `mkfs.ext4 -d` and sets every inode to root with `debugfs`.

In the box, `tumpel-init` mounts the second drive as the overlay upper directory and formats it on first boot. It then pivots into the overlay and starts systemd. `tumpel-guest` listens on vsock port 1024 and announces itself on host port 1025. It keeps one harness process per box and starts it with the turn's provider key in the environment variable `providerKeyName` in `guest.json` names. A turn whose key or model differs from the running process's restarts the harness, continuing the conversation. The key is never written to the guest disk or logged. Before the harness starts, the guest clones the turn's `repository` into the empty harness working directory, `/root/workspace`, at its default branch; git reads `GITHUB_TOKEN` from the environment through a credential helper set in `GIT_CONFIG_*` variables, and `gh` reads it as `GH_TOKEN`. A directory that already holds a repository, on a resumed or restored box, is left as it is.

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
