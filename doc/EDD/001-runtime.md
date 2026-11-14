# EDD-001: Runtime

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

The supervisor runs each session in a Firecracker microVM, the box, on a tenant's Linux host with KVM. A box boots from a read-only image shared by digest and keeps the session's own files on a separate writable drive. Between turns, the supervisor pauses the box for the warm window and tears it down once the window ends. An installer prepares the host once with admin rights, and from then on the supervisor runs as an ordinary user.

## Box lifecycle

Each harness version has one read-only root image and one kernel, both named by digest, and a manifest that lists their parts. The supervisor refuses a guest whose greeting disagrees with the manifest.

A second drive per session holds the overlay upper directory, which the guest's init mounts over the image before it starts the guest agent. Over vsock, the agent speaks length-prefixed JSON to the supervisor, and it dials the host once ready.

For a harness that reads turns as a stream, as Claude Code does, the agent keeps one harness process per box. A harness that reads one prompt per process gets one process per turn. A process stays in use while the harness, the model and the exported secrets stay the same. The harness runs as root with full permissions.

When a turn ends, the supervisor pauses the box's vCPUs and starts a timer for that box. The timer runs for `warmWindowSeconds` from the host's runtime config, 900 s by default. A turn inside the window resumes the paused process. When the timer fires, the supervisor stops the process and deletes the box's drive. When every slot on the host is taken, a new box evicts the box that has been paused longest.

The warm state is the paused process in host memory. The supervisor writes no memory file to disk.

## Host setup

The installer runs once with admin rights. It:

1. adds the supervisor's user to the `kvm` group;
2. installs Firecracker at its pinned version, checked against its digest;
3. makes a pool of TAP devices owned by that user, one per box slot, each with its own /30 and IPv4 masquerade;
4. installs the guest filter as a unit that loads before the host network comes up;
5. installs the static supervisor binary and a service that runs it as that user.

The host then enrols with `tumpel-supervisor enrol`, which reads the token from a file. Firecracker runs without its jailer, because the jailer needs root.

## Networking and isolation

Each box takes one TAP from the pool and its own /30 in the 172.16 private range. The host masquerades the box's traffic to the internet. The guest filter drops forwarded traffic to these ranges:

- 10.0.0.0/8
- 100.64.0.0/10
- 169.254.0.0/16
- 172.16.0.0/12
- 192.168.0.0/16

Those ranges cover the LAN, the hypervisor and every other box. On the host itself, the filter accepts a box's packets only at that box's gateway. IPv6 forwarding is off. The guest resolves names through 1.1.1.1 and 9.9.9.9.

## Measured numbers

Measured on 2026-11-14 on the reference host: a nested KVM guest with 4 vCPU and 8 GiB.

| Step                                   | Time   |
| -------------------------------------- | ------ |
| First guest serial line                | 159 ms |
| Guest agent ready over vsock           | 2.8 s  |
| vsock round trip, median               | 8 ms   |
| Cold boot plus one turn, Shell harness | 2.6 s  |

Guest random reads at 4 KiB and queue depth 1 reach about 11,000 IOPS, 50 percent of the host filesystem. The guest block path sets that cap. Bare metal is not measured yet.

## FAQ

**Does the supervisor ever need root?** No. The installer does the privileged work once.

**What does a box hold after teardown?** Nothing. The session lives on in its snapshots.
