# EDD-007: Guest layers

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md). It covers FR-15 to FR-20 and OR-5.

## Summary

A box boots from four read-only parts. An image release tag builds the base image: Ubuntu and the dev tools. A harness layer holds one harness at one version. The guest drive holds the guest agent from the supervisor's own build. A prebuild layer holds a repository's dependencies (RFC: Prebuilds). The session overlay sits on top. So a harness bump publishes one layer, and a guest change ships in the supervisor release.

## Layer format

Every harness layer and the guest drive are squashfs images compressed with zstd. The guest kernel the images pin, Firecracker CI `vmlinux-6.18.62`, builds squashfs in with zstd and leaves erofs out (appendix of kernel facts). The base image stays ext4.

A layer is named by the sha256 of its squashfs file. `npm run harness:layer -- <harness> <arch>` installs the catalog's `installRecipe` into a staging tree whose root becomes `/opt/harness/<harness>/<version>`, writes the harness's `GuestHarness` there as `tumpel-harness.json`, and packs it with `mksquashfs -comp zstd -all-root -all-time 0 -mkfs-time 0`. mksquashfs 4.6.1 builds reproducibly by default, so a single native package such as Claude Code yields one digest. A harness with npm dependencies resolves them at build time, so its digest can vary. CI builds each recipe once, and hosts verify the digest the release names.

CI builds layers, because a host-built layer has no published digest to check. The binaries job builds only the layers whose recipe the bucket lacks. A push that leaves the catalog alone pays one HEAD request per catalog entry.

## Host cache

| Part          | Path under `imageCacheDir`          | Kept                                                        |
| ------------- | ----------------------------------- | ----------------------------------------------------------- |
| Base image    | `<digest>.ext4`, `<digest>.json`    | Newest base per architecture, plus any a live box holds     |
| Harness layer | `layers/<digest>.squashfs`, `.json` | Until evicted                                               |
| Guest drive   | `guest/<digest>.squashfs`           | The running supervisor's own; others go at supervisor start |

A layer download moves into place once its sha256 matches the release's digest. Only the supervisor writes the cache, so a placed file is trusted at attach. Each attach sets the layer's modification time. After a new layer lands, the supervisor deletes the least recently attached layers, never one a live box holds, until the layers fit `layerCacheMib` in `runtime.json`, 8,192 by default.

Every fetch takes the host's one fetch lock. A box that needs a layer another box is fetching waits on that lock within its `fetchSeconds`, then finds the layer cached. Base, kernel and layer share that budget.

## Release manifest

`current.json`, which `GET /v1/releases/current` serves, names:

- `bases`: one `ReleaseBaseImage` per architecture, with `imageDigest`, `kernelDigest`, `manifestDigest`, `ociDigest` and `rootfsDigest`, copied from `images.json`.
- `harnessLayers`: one `ReleaseHarnessLayer` per harness, version and architecture, with `layerDigest`, `manifestDigest` and `sizeBytes`. Shell joins as a layer for tests.
- `supervisors`: each `ReleaseSupervisor` adds `guestDriveDigest`, the digest of the guest drive inside that binary.

`ImageRelease` names `bases` and `baseLayoutVersion`, without `guestProtocolVersion`. `rootfsDigest` is the diff_id of the base's root filesystem tar, with no harness and no guest agent. Prebuild jobs load that tar.

The guest drive holds `tumpel-guest`, its systemd unit and `init`, the mount sequence below. The release job packs it, and the supervisor embeds it with `include_bytes!` and writes it to the cache at start. A supervisor that cannot write it exits `GuestDriveUnwritable`, code 8. `release-publish` drops the GuestProtocol refusal. It refuses a release whose commit's `BaseLayout.Version` differs from `images.json`'s `baseLayoutVersion`, and names the image release tag to push.

## Boot and mount sequence

| Slot  | Drive                                               |
| ----- | --------------------------------------------------- |
| `vda` | Base image, root device, read-only                  |
| `vdb` | Session overlay, writable                           |
| `vdc` | Guest drive, read-only                              |
| `vdd` | Harness layer, read-only                            |
| next  | Prebuild layer, read-only, when the session has one |
| next  | Restore archive, read-only, on a cold restore       |

Firecracker names drives in the order the supervisor configures them, so the first four slots are fixed. The supervisor names the optional drives on the kernel command line as `tumpel.prebuild=vdX` and `tumpel.restore=vdX`.

1. The base's stub `/usr/local/sbin/tumpel-init` mounts `vdc` at `/opt/tumpel/guest` and runs `/opt/tumpel/guest/init`.
2. That init mounts the overlay drive, formats it on first boot and unpacks a restore archive into the upper directory, as now.
3. It mounts the overlay with `lowerdir=<prebuild>:/`, so the prebuild layer sits over the base, under the session's upper directory.
4. It mounts a tmpfs at `/opt/harness` in the merged root, mounts `vdd` at `/opt/harness/<harness>/<version>` and moves the guest mount into the merged root.
5. It pivots and starts systemd. The guest agent reads `tumpel-harness.json`, puts the layer's `bin` first on `PATH` and names the harness and version in GuestHello.

Every step runs within `bootSeconds`. A failed step prints `tumpel-init: <step> failed: <error>` on the console, and the turn fails BoxBootFailed with that tail. When GuestHello names another harness than the offer, the turn fails BoxBootFailed. Fetching fails ImageFetchFailed, ImageFetchTimedOut or ImageNotReleased, naming the part. TurnOffer adds the harness layer's digests and URLs, which takes channel protocol 11. A Claude setup box boots the same stack.

## Prebuilds, snapshots and the proof

The harness and guest mounts sit outside the overlay, so a snapshot holds none of their files and does not depend on the harness digest. A prebuild runs no harness, and its key names the base's `imageDigest`, so one prebuild serves every harness. `prebuild.mjs` stays in the base, because CI prebuild jobs load only the base tar. The supervisor packs a fetched prebuild layer into a squashfs with the backhand crate and caches it by prebuild key.

The proof keeps its seventeen steps. Step 4's first turn now fetches the base and the harness layer within the fetch budget. Step 2's published supervisor carries the guest drive.

`images.yml` builds the base only, without the Rust toolchain or the guest. `release.yml` packs the guest drive, builds missing harness layers and publishes the crates on a `v*` tag (OR-5).

## Does not fit

- erofs: the pinned kernel leaves `CONFIG_EROFS_FS` unset. Squashfs is built in.
- Disk by-id: Firecracker derives a drive's virtio serial from the host file's device and inode numbers, and the stub init runs before udev. Fixed slots and the kernel command line replace it.
- Drive count: with `pci=off` on x86_64, each virtio-mmio device takes one of 19 legacy interrupts. Net and vsock take two, which leaves 17 drives against the six a box uses. Past 17, Firecracker's PCI transport lifts the limit.
- Hotplug: Firecracker attaches drives before boot, so a warm box keeps its harness layer.
- Decompression: the kernel builds one squashfs decompressor per mount. If step 4's first line slows, `-noD -noF` stores data uncompressed at a larger download.
- Boot cost: the extra drives and mounts are not measured. Stage 7 measures them.
- Size: the Claude Code image uses 687 MB and the Shell image 373 MB on the build machine, and each harness image repeats the base. A compressed layer is not measured.
- Skew: a smaller contract remains between the stub init and the guest drive's init. `release-publish` checks it as `baseLayoutVersion`.
- Prebuild script: a change to `prebuild.mjs` still needs an image release. Moving it to the guest drive means a second URL for the orb.
- crates.io: `tumpel-api` must publish before `tumpel`. Whether trusted publishing can create a first version is not checked. If not, a person publishes each crate once.

## CI minutes

A guest change saves about 13 job minutes and 4 minutes of wall clock, because it needs no image run. A harness bump saves about 12 job minutes the same way. Other pushes to main cost about 0.4 job minutes more. The appendix holds the measured baseline.

## Build plan

Each stage is one push by one lane, in this order. Stages 1 and 2 must be on main and released before stage 5.

1. devops: `harness:layer`, `HarnessLayerManifest` and `ReleaseHarnessLayer`. The binaries job builds missing layers, and `current.json` gains `harnessLayers`.
2. devops: `guest:image -- base` builds the base with the stub init. `images.json` carries `bases` beside the harness images. Tag an image release.
3. engineer: the binaries job packs the guest drive. The supervisor embeds it, writes it at start and exits `GuestDriveUnwritable`.
4. engineer: the host layer cache, with digest checks, eviction past `layerCacheMib` and the shared fetch lock.
5. engineer: layered boot. TurnOffer names base and layer on channel protocol 11. The supervisor attaches the six slots, the guest drive's init mounts the stack, and placement reads `bases` and `harnessLayers`.
6. devops: `release-publish` swaps the GuestProtocol refusal for `baseLayoutVersion`, and image releases carry bases only.
7. engineer: prebuild keys name the base digest, prebuild layers mount as squashfs, and the proof records step 4 against the old cold first line.
8. devops: crates.io publishing of `tumpel-api` and `tumpel` on `v*` tags.

## FAQ

**Why not erofs?** The guest kernel lacks it. Squashfs is built in.

**Why not virtiofs?** Firecracker has no virtio-fs device. Its virtio devices are block, net, vsock, balloon, mem, pmem and rng.

**Can a host run two versions of one harness?** Yes. Layers sit side by side by digest.

**Can the guest and the supervisor disagree?** No. The supervisor carries its own guest.

## Appendix of kernel facts

Checked on 2026-11-15 against `resources/guest_configs/microvm-kernel-ci-x86_64-6.18.config` and the aarch64 file in `firecracker-microvm/firecracker`, and against the strings of the pinned `vmlinux-6.18.62` (sha256 `0ee1eb90...`).

| Option                          | x86_64  | aarch64     |
| ------------------------------- | ------- | ----------- |
| `CONFIG_SQUASHFS`               | y       | y           |
| `CONFIG_SQUASHFS_ZSTD`          | y       | y           |
| `CONFIG_SQUASHFS_DECOMP_SINGLE` | y       | not checked |
| `CONFIG_EROFS_FS`               | not set | not set     |
| `CONFIG_OVERLAY_FS`             | y       | y           |
| `CONFIG_VIRTIO_BLK`             | y       | not checked |

Firecracker's `src/vmm/src/arch/x86_64/layout.rs` sets legacy GSIs 5 to 23. `device_manager/mmio.rs` gives each virtio-mmio device one. `devices/virtio/block/virtio/device.rs` builds the virtio-blk id from `st_dev`, `st_rdev` and `st_ino`. `docs/block.md` states that the root device becomes `/dev/vda` and the rest follow in configuration order. The kernel's `overlayfs.rst` stacks lower directories from left to right, top first.

## Appendix of CI minutes

Measured on 2026-11-15. Image run `images-v0.1.2` took 14.3 job minutes and 4.2 minutes wall clock, 10.3 job minutes of it checks. Release run 43762892658 took 14.1 job minutes and 4.4 minutes, 10.9 of it checks. Today a guest or harness change needs both runs.

| Change                 | Today                 | After, estimated          | Saved            |
| ---------------------- | --------------------- | ------------------------- | ---------------- |
| Guest fix or bump      | 28.4 job min, 8.6 min | about 15 job min, 4.5 min | about 13 job min |
| Harness pin bump       | 28.4 job min, 8.6 min | about 16 job min, 4.5 min | about 12 job min |
| Base change            | 28.4 job min          | about 27 job min          | about 1 job min  |
| Any other push to main | 14.1 job min          | about 14.5 job min        | costs 0.4        |

The estimates assume the guest drive adds one job minute, a harness layer two, and `squashfs-tools` half a minute. A base image run drops the Rust toolchain and the guest build.
