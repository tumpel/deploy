# EDD-001: Runtime

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

The supervisor runs each session in a Firecracker microVM, the box, on a tenant's Linux host with KVM. A box boots from a read-only image shared by digest and keeps the session's own files on a separate writable drive. Between turns, the supervisor pauses the box for the warm window and tears it down after the window, once a snapshot holds its last turn. `tumpel-supervisor install` prepares the host once with sudo, and from then on the supervisor runs as an ordinary user.

## Box lifecycle

Each harness version has one read-only root image and one kernel, both named by digest, and a manifest that lists their parts. The supervisor refuses a guest whose greeting disagrees with the manifest.

A second drive per session holds the overlay upper directory, which the guest's init mounts over the image before it starts the guest agent. A cold boot of a session with snapshots attaches a third, read-only drive that holds the restored files (EDD-004). Over vsock, the agent speaks length-prefixed JSON to the supervisor, and it dials the host once ready.

For a harness that reads turns as a stream, as Claude Code does, the agent keeps one harness process per box. A harness that reads one prompt per process gets one process per turn. A process stays in use while the model, the exported variables and the persona's files stay the same. The harness runs as root with full permissions.

Each turn offer carries the persona's file list with a download URL per digest. The supervisor caches the files by digest and passes them to the guest over vsock. The guest writes them under the harness home before the harness starts.

## Repository

The images carry pinned git and gh. Before the harness starts, the guest clones the session's repository into the working directory `/root/workspace`. A directory that holds the repository already skips the clone. Git reads `GITHUB_TOKEN` from the environment through a credential helper, so the token stays out of the URL and off the disk. The clone runs within the image's `cloneSeconds`, 120 s. A clone that fails or runs out of time ends the turn `RepositoryCloneFailed` with a cause (`Refused`, `TimedOut`, `DirectoryNotEmpty` or `Other`) and what git reported. The control plane adds advice to set a `GITHUB_TOKEN` member only when git was refused and the turn's credential handover carried no such variable. Until the guest sends `TurnRepositoryReady`, the first line is due within `cloneSeconds` plus `budgets.firstLineSeconds`; once it arrives, the first-line budget restarts there. Commits carry the persona's `gitAuthorName` and `gitAuthorEmail`, and gh reads the token as `GH_TOKEN`.

## Warm window

Turns for different sessions run in parallel. When a turn ends, the supervisor pauses the box's vCPUs and arms a timer for that box. The timer runs for `warmWindowSeconds` from the host's runtime config, 900 s by default. A turn inside the window cancels the timer and resumes the paused process. Once the timer has fired and the box's last turn is in a snapshot, the supervisor stops the box and deletes its drive. A session stop ends the window early: the supervisor tears the box down on BoxTeardown (EDD-004).

The warm state is the paused process in host memory. The supervisor writes no memory file to disk.

## Host setup

`tumpel-supervisor install` runs once and uses sudo for that run only. It:

1. adds the supervisor's user to the `kvm` group;
2. installs Firecracker and the guest kernel at pinned versions, each checked against its digest;
3. makes `boxCapacity` TAP devices owned by that user through systemd-networkd, where device `tumpel<k>` has gateway 172.16.<k>.1/30 and IPv4 masquerade;
4. installs the guest filter as a unit that loads before the host network comes up;
5. installs the supervisor binary and a lingering user unit that runs `tumpel-supervisor run`.

`boxCapacity` sits in the runtime config, between 1 and 256, 8 by default. The host then enrols with `tumpel-supervisor enrol`, which reads the token from a file and keeps an existing runtime config. Firecracker runs without its jailer, because the jailer needs root. The installer and the binaries are built for x86_64 only for now.

## Networking and isolation

Each box claims the lowest free device `tumpel<k>`, takes guest IP 172.16.<k>.2 and its own MAC, and returns the device at teardown. When every device is taken, the supervisor evicts the longest-paused box that has nothing left to snapshot. With no such box, the turn fails `PoolExhausted`, naming the capacity and the boxes held.

The host masquerades the box's traffic to the internet. The guest filter drops forwarded traffic from a source outside 172.16.0.0/16, and forwarded traffic to these ranges:

- 10.0.0.0/8
- 100.64.0.0/10
- 169.254.0.0/16
- 172.16.0.0/12
- 192.168.0.0/16

Those ranges cover the LAN, the hypervisor and every other box. On the host itself, the filter drops every packet a box sends, so a box reaches no host service. IPv6 forwarding is off. The guest resolves names through 1.1.1.1 and 9.9.9.9.

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
