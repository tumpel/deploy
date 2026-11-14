# Runtime spike: Firecracker on the dev host

Date: 2026-11-14. Host: x86_64, 8 vCPU, 15 GB RAM, Linux 6.8.0-106-generic.

| Step                                                         | Result  | Measured                                     |
| ------------------------------------------------------------ | ------- | -------------------------------------------- |
| 1. Open `/dev/kvm`                                           | Blocked | `EACCES: permission denied, open '/dev/kvm'` |
| 2. Boot over the API socket, first serial line, vsock accept | Not run | none                                         |
| 3. Guest listener runs `uname -a` over vsock                 | Not run | none                                         |
| 4. Full and diff snapshot, restore, rerun                    | Not run | none                                         |
| 5. `claude` binary and network path in the guest             | Not run | none                                         |

## What blocked

`/dev/kvm` and `/dev/vhost-vsock` are `root:kvm`, mode 660. The user `mvhenten` is not in the `kvm` group, so no VM monitor can start. The host needs `usermod -aG kvm mvhenten` and a new login before the spike can rerun. Firecracker uses its own vsock backend over a Unix socket, so `/dev/vhost-vsock` access is not needed for it.

## Versions and artifacts

- Firecracker v1.18.0 (released 2026-11-09): `https://github.com/firecracker-microvm/firecracker/releases/download/v1.18.0/firecracker-v1.18.0-x86_64.tgz`
- Kernel: `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261111-778a26c0594c-0/x86_64/vmlinux-6.18.62`
- Rootfs: `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261111-778a26c0594c-0/x86_64/ubuntu-24.04.squashfs`

The quickstart ships the rootfs as squashfs, and its ext4 recipe runs `sudo chown` and `sudo mkfs.ext4`. A guest image build without root uses `mkfs.ext4 -d` with `-E root_owner=0:0`.

## Consequences for the supervisor crate

1. API driving. The supervisor speaks HTTP over the per-box API Unix socket: `PUT /machine-config`, `/boot-source`, `/drives/{id}`, `/vsock`, then `PUT /actions` with `InstanceStart`. A typed client over `hyper` on a Unix stream covers it; a Firecracker SDK crate is not required.
2. Vsock protocol framing. A host-initiated connection opens the vsock Unix socket, writes `CONNECT <port>\n` and reads `OK <port>\n`. A guest-initiated connection lands on `<uds_path>_<port>`. The turn protocol runs length-prefixed frames after that handshake.
3. Snapshot cadence. Firecracker resets the vsock device on restore: open connections drop and guest listeners survive. The supervisor reconnects after every restore. Diff snapshots are in developer preview and do not resume alone; they need a merge into the base. Memory snapshots stay on the host for warm resume; they are never uploaded.
4. Jailer. The jailer creates a chroot, cgroups and namespaces, which needs root. The supervisor never escalates (lesson 25), so the installer runs the jailer setup once or v1 runs Firecracker unjailed as the `kvm` group user.
5. Disk layout. Firecracker has no shared filesystem device, only block drives. The read-only lower layers are one or more ext4 drives cached by digest, and the overlay upper directory is a separate writable ext4 drive per box. That drive is the snapshot unit.
