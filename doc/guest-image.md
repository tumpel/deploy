# Guest image

`npm run guest:build` builds `tumpel-guest` as a static x86_64 binary. `npm run guest:image -- <harness>` then builds a read-only ext4 rootfs without root, for `ClaudeCode` from the harness catalog or `Shell` for tests. It writes `<digest>.ext4`, `<digest>.json` (`GuestImageManifest`) and `<kernelDigest>.vmlinux` to `$TUMPEL_IMAGE_DIR`, by default `~/development/.tmp/tumpel-images`.

The build:

1. Downloads the Firecracker CI Ubuntu 24.04 squashfs and kernel, and for Claude Code the Node runtime, each checked against the digest pinned in `npm-scripts/guest-image.mjs`.
2. Unpacks the squashfs with `unsquashfs`, adds `tumpel-guest`, its systemd unit, `/usr/local/sbin/tumpel-init` and `/etc/tumpel/guest.json` (`GuestHarness`), and runs `npm install` for the catalog's pinned package.
3. Packs the tree with `mkfs.ext4 -d` and sets every inode to root with `debugfs`.

In the box, `tumpel-init` mounts the second drive as the overlay upper directory and formats it on first boot. It then pivots into the overlay and starts systemd. `tumpel-guest` listens on vsock port 1024 and announces itself on host port 1025. It keeps one harness process per box and gives each turn's `DispatchGrant` variables to that process's environment.

The vsock protocol is length-prefixed JSON: a 4-byte big-endian length, then one `GuestMessage` from the guest or one `GuestTurnStart` from the host, as `supervisor.tsp` defines them.

## Host prerequisites

- `/dev/kvm` readable by the supervisor's user (group `kvm`), and Firecracker v1.18.0 at `firecrackerPath` in `runtime.json` (`SupervisorRuntime`). Firecracker runs unjailed as that user.
- One TAP device owned by that user, made once by the installer: `tumpel0`, a systemd-networkd TAP with host address 172.16.0.1/30 and IPv4 masquerade (see `test-host.md`). The supervisor never needs `CAP_NET_ADMIN`. The guest takes 172.16.0.2/30. Egress is open to the internet; private and link-local destinations are dropped (see `test-host.md`).
- `unsquashfs`, `mkfs.ext4`, `debugfs` and `e2fsck` on the machine that builds images.

The host test runs a Shell box through boot, a turn, a snapshot, resume and a second turn:

```sh
TUMPEL_KVM=1 TUMPEL_IMAGE_MANIFEST=<cache>/<digest>.json cargo test -p tumpel-supervisor --features host-tests -- --nocapture
```
