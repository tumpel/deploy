# Runtime spike: Firecracker measured

Date: 2026-11-14. Both machines are KVM guests on the same AMD Ryzen 7 5700G host with nested KVM. **sandbox** (dev only): 8 vCPU, 15 GiB, Linux 6.8.0-106, ext4 on virtio disk. **tumpel-host** (reference host): host-passthrough CPU, 4 vCPU, 8 GiB, Linux 6.8.0-147, ext4 on virtio disk. Box: 1 vCPU, 512 MiB, root drive with `cache_type: Writeback`, `io_engine: Sync`, `track_dirty_pages: true`. Times are from spawning `firecracker`.

| Step                                                            | sandbox          | tumpel-host      |
| --------------------------------------------------------------- | ---------------- | ---------------- |
| 1. API socket accepts                                           | 118.0 ms         | 2.2 ms           |
| 1. Six config PUTs and `InstanceStart` returned                 | 132.6 ms         | 17.2 ms          |
| 1. First guest serial line                                      | 287.6 ms         | 158.5 ms         |
| 1. Guest listener up under systemd, host accepts its vsock dial | 3,282 ms         | 2,813 ms         |
| 2. First `uname -a` round trip (new vsock connection per call)  | 18.8 ms          | 10.4 ms          |
| 2. 20 round trips, median / p95                                 | 11.5 / 27.5 ms   | 8.0 / 15.3 ms    |
| 3. Full snapshot (pause excluded, fsync included)               | 1,005 ms         | 748 ms           |
| 3. Full snapshot size: memory / state                           | 512 MiB / 13 KiB | 512 MiB / 13 KiB |
| 3. Diff snapshot after one command                              | 90.5 ms          | 28.1 ms          |
| 3. Diff memory file, allocated (sparse, 512 MiB apparent)       | 10.5 MiB         | 4.4 MiB          |
| 3. Restore full: `/snapshot/load` / spawn to first vsock reply  | 2.6 / 239 ms     | 2.5 / 96 ms      |
| 3. Merge diff into base (`snapshot-editor edit-memory rebase`)  | 41.7 ms          | 3.8 ms           |
| 3. Restore merged: spawn to first vsock reply                   | 170.5 ms         | 79.1 ms          |
| 3. Round trips after restore, median / p95                      | 11.9 / 22.6 ms   | 11.0 / 16.6 ms   |
| 4. fio 4 KiB QD1 randread / randwrite IOPS, guest               | 11,140 / 9,468   | 11,364 / 10,544  |
| 4. Same on the host filesystem holding the drive                | 14,198 / 12,594  | 22,593 / 18,471  |
| 4. fio 4 KiB QD32 randread / randwrite IOPS, guest              | 14,833 / 21,285  | 13,800 / 12,119  |
| 4. Same on the host filesystem                                  | 114,543 / 87,919 | 127,468 / 93,397 |
| 4. Guest QD32 with `io_engine: Async`                           | 25,579 / 27,878  | 13,959 / 20,149  |
| 4. `dd bs=4k oflag=direct` 100 MiB sequential write, guest      | 35.0 MB/s        | 37.6 MB/s        |

fio 3.36 from the rootfs, `--direct=1 --ioengine=libaio --size=256M --runtime=8`; the host baseline runs the same fio binary with the guest's libraries. Bare metal was not measured.

## What blocked

Steps 1 to 4 passed on both machines. Step 5: creating a TAP device as the supervisor user fails with `ioctl(TUNSETIFF): Operation not permitted` (`ip tuntap add dev tspk0 mode tap`).

## Versions and artifacts

- Firecracker v1.18.0 and `snapshot-editor`: `https://github.com/firecracker-microvm/firecracker/releases/download/v1.18.0/firecracker-v1.18.0-x86_64.tgz`
- Kernel 6.18.62: `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261111-778a26c0594c-0/x86_64/vmlinux-6.18.62`
- Rootfs Ubuntu 24.04.5: `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261111-778a26c0594c-0/x86_64/ubuntu-24.04.squashfs`, converted without root by `unsquashfs` and `mkfs.ext4 -d` into a 2 GiB ext4, with every inode set to uid and gid 0 by `debugfs sif` (the squashfs lists all 6,743 entries as 0/0).
- Host driver: Rust 1.96, tokio 1.54, static glibc (`+crt-static`). Guest listener: std-only Rust, static glibc; the musl target is not installed. API references: the v1.18.0 tag's `firecracker.yaml`, `docs/vsock.md` and `docs/snapshotting/snapshot-support.md`; context7 was not available and `tokio-vsock` was not needed.

## Consequences for the supervisor crate

1. API driving. Raw HTTP/1.1 over a tokio `UnixStream` covers every call; no `hyper` or SDK crate. Firecracker creates the API socket itself, so the supervisor waits for it under a budget before the first PUT.
2. Vsock framing. Host to guest: connect to the vsock Unix socket, `CONNECT 5000\n`, read `OK <port>\n`, then u32 big-endian length-prefixed frames. Readiness is an event: the guest dials host port 5001, which lands on `<uds_path>_5001`. Snapshot creation resets vsock, so each turn opens its own connection; the guest listener survives snapshot and restore.
3. Snapshot cadence. A full snapshot writes all guest memory (512 MiB, 0.75 to 1 s). A diff after one command is 4 to 11 MiB in 28 to 90 ms, merges into the base in under 42 ms, and the merged pair restores. Restore reaches the first reply in 80 to 240 ms against about 3 s for a cold boot. The supervisor takes a full snapshot once per box, a diff on each turn completion, and merges on the host; memory files stay on the host. The drive file is not in a Firecracker snapshot, so the supervisor copies the drive at the same pause.
4. Jailer and capabilities. The spike ran unjailed as a `kvm` group member with no capability and no access to `/dev/vhost-vsock`. The jailer needs root for chroot, cgroups and device nodes, so the supervisor cannot run it. Networking needs one TAP per box: either the installer pre-creates TAPs owned by the supervisor user plus NAT once, or the supervisor holds `CAP_NET_ADMIN`.
5. Disk layout. Guest images build without root (`mkfs.ext4 -d`, then `debugfs` for ownership). At 1 vCPU guest random I/O tops out near 12,000 to 28,000 IOPS on either machine: QD1 is 50 to 78 percent of the host filesystem, QD32 is 11 to 24 percent. The overlay upper directory sits on its own writable ext4 drive per box; read-only lower layers are separate drives.
6. `claude` in the guest. Claude Code 2.1.317 is one 316 MiB ELF linked only against glibc (`libc`, `libm`, `libpthread`, `libdl`, `librt`), which the Ubuntu 24.04 rootfs provides along with `ca-certificates.crt` and `systemd-networkd`. Outbound network needs a virtio-net device on a host TAP and guest address configuration. The 2 GiB image has about 1.6 GiB free.
7. Tenant hosts. Nested KVM with host-passthrough runs every step; tumpel-host boots, snapshots and restores 1.2 to 3 times faster than sandbox. The guest block path caps random I/O on both, so nesting is not the limit measured here. Enrolment requires `/dev/kvm`; a bare-metal comparison is still unmeasured.
