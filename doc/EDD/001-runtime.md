# EDD-001: Runtime

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

The supervisor runs each session in a Firecracker microVM, the box, on a tenant's Linux host with KVM. A box boots from a read-only image shared by digest and keeps the session's own files on a separate writable drive. Between turns, the supervisor pauses the box for the warm window and tears it down after the window, once a snapshot holds its last turn. `tumpel-supervisor install` prepares the host once with sudo, and from then on the supervisor runs as an ordinary user.

## Box lifecycle

Each harness version has one read-only root image and one kernel, both named by digest, and a manifest that lists their parts. The supervisor refuses a guest whose greeting disagrees with the manifest. The greeting, GuestHello, also carries `protocolVersion`, now 2. On any other version the supervisor fails the turn BoxBootFailed, and the detail names both versions and says to rebuild the image.

A second drive per session holds the overlay upper directory, which the guest's init mounts over the image before it starts the guest agent. A cold boot of a session with snapshots attaches a third, read-only drive that holds the restored files (EDD-004). Over vsock, the agent speaks length-prefixed JSON to the supervisor, and it dials the host once ready.

For a harness that reads turns as a stream, as Claude Code does, the agent keeps one harness process per box. A harness that reads one prompt per process gets one process per turn. A process stays in use while the model, the exported variables and the persona's files stay the same. The harness runs as root with full permissions.

Each turn offer carries the persona's file list with a download URL per digest. The supervisor caches the files by digest and passes them to the guest over vsock. The guest writes them under the harness home before the harness starts.

A host chunk cache under `imageCacheDir/chunks` keeps snapshot chunks by digest, with no eviction (EDD-004).

## Guest images

Each turn offer names a guest image of the current release: its image, kernel and manifest digests, with a presigned URL for each (EDD-002). The supervisor boots a box only from its image cache, `imageCacheDir`. When the cache lacks the image, the supervisor sends TurnImageFetching and downloads the three files, one fetch at a time. Each file lands under a temporary name. The supervisor checks each file against its sha256 and only then renames it into place. The cache keeps one image per harness version, so a new image replaces the one before it. Kernels are shared by digest, and the supervisor skips a kernel the cache already holds. The release's kernel is the only kernel. A warm box keeps the image it booted from.

The fetch runs before the claim, under its own budget: `turnImageFetchBudgetSeconds` in `ControlPlaneSettings`, 900 s by default. When a download fails or misses its digest, the turn fails ImageNotCached. A fetch that outlasts the budget fails it ImageFetchTimedOut. The turn fails ImageNotReleased when the current release lacks its image for the host's architecture.

## Repository

The images carry pinned git and gh. Before the harness starts, the guest clones the session's repository into the working directory `/root/workspace`. A directory that holds the repository already skips the clone. Git reads `GITHUB_TOKEN` from the environment through a credential helper, so the token stays out of the URL and off the disk. The clone runs within the image's `cloneSeconds`, 120 s. A clone that fails or runs out of time arrives as `TurnRepositoryCloneFailed`, with a cause and what git reported. Its cause is `Refused`, `TimedOut`, `DirectoryNotEmpty` or `Other`. That message fails the turn `RepositoryCloneFailed`, and its detail asks for a `GITHUB_TOKEN` member only on `Refused`, when the turn's credential handover carried no such variable. Until the guest sends `TurnRepositoryReady`, the first line is due within `cloneSeconds` plus `budgets.firstLineSeconds`; once it arrives, the first-line budget restarts there. Commits carry the persona's `gitAuthorName` and `gitAuthorEmail`, and gh reads the token as `GH_TOKEN`.

## Warm window

Turns for different sessions run in parallel. When a turn ends, the supervisor pauses the box's vCPUs and arms a timer for that box. The timer runs for `warmWindowSeconds` from the host's runtime config, 900 s by default. A turn inside the window cancels the timer and resumes the paused process. The supervisor reuses a warm box only when the turn names that box. Otherwise it stops the box and boots a fresh one. Once the timer has fired and the box's last turn is in a snapshot, the supervisor stops the box and deletes its drive. A session stop ends the window early: the supervisor tears the box down on BoxTeardown (EDD-004).

The warm state is the paused process in host memory. The supervisor writes no memory file to disk.

## Placement

The supervisor reads its usage from /proc: warm boxes, the one-minute load average and `MemAvailable` in MiB. When it cannot, it stops with `UsageUnreadable`, exit code 7. It sends that usage and its `boxCapacity` over the channel (EDD-002). The tenant's Durable Object keeps the latest per host in its `host_usage` table and places one request at a time.

A host's free slots are its `boxCapacity`, minus the tenant's `Offered` and `Running` turns on it, minus its warm boxes. A host is Full when those turns reach its `boxCapacity`. The tenant picks an Online host that is not Full and whose architecture has an image of the session's harness version in the current release. It ranks those by free slots, then by available memory. With every host Full, the tenant refuses the start `PoolExhausted` and lists each host's reason. A tenant with no host gets `NoHostAvailable`. The tenant refuses a start on an Online host that has sent no usage yet. The refusal names the host and says to restart `tumpel-supervisor run` there, so that its Hello carries its usage. `tumpel host list-usage` lists the slots, load and memory of each host that has connected, leaving out revoked hosts. Placement ignores the load.

Warm boxes never make a host Full. A host whose slots are all warm still takes a session, and its supervisor evicts a warm box as Networking describes.

## Moving a session

A placed session keeps its host. Each turn records the host it runs on. A send stays on the session's host while that host is Online. When the host is not Online and a completed turn is newer than the latest snapshotted turn, the tenant refuses the send `HostOffline` and names the host and the missing turns. Otherwise the tenant places the session as it places a new one. It fails the session's pending snapshot requests `NotAnswered` and sends BoxDiscard to the old host, unless the session's state is Stopped. A fresh box then boots on the new host from the latest snapshot. The tenant refuses a stop `HostOffline` while the host is offline.

## Host setup

A fresh host fetches the supervisor binary with `curl -fL <origin>/v1/releases/supervisor/Amd64`. Adding the host is then one command over ssh. `tumpel host mint-token` mints a one-time enrolment token. `tumpel-supervisor install --endpoint <stage origin> --token-file <path|->` then sets the host up, enrols it and starts the unit. It reads the token from a file or from stdin (`-`), so the token stays off the command line. Sudo runs for the installer's own run only. The supervisor itself never asks for admin rights. The installer:

1. refuses a host that is already enrolled, before any setup step;
2. tries `sudo -n`, then asks for the password when it has a terminal. Without a terminal it stops and names two fixes: the NOPASSWD sudoers line, or a run from a terminal with the token saved to a file;
3. adds the supervisor's user to the `kvm` group, restarts the user manager and checks once that the group can read and write `/dev/kvm`;
4. writes the runtime config, `runtime.json`;
5. installs Firecracker at a pinned version, checked against its digest;
6. installs the guest filter as a unit that loads before the host network comes up;
7. makes `boxCapacity` TAP devices owned by that user through systemd-networkd, where device `tumpel<k>` has gateway 172.16.<k>.1/30 and IPv4 masquerade;
8. installs the supervisor binary and a lingering user unit that runs `tumpel-supervisor run`;
9. enrols the host and starts the unit.

## Running host

A supervisor that fails restarts after 5 s. Exit codes 3 (NotEnrolled) and 5 (HostRevoked) stop it for good. Exit code 6 (ProtocolError) means the supervisor needs an update, so the unit waits 60 s before each restart. The supervisor does not update itself yet.

Running `install` without `--endpoint` and `--token-file` only sets up the host, and it restarts the unit when the host is enrolled. `tumpel-supervisor enrol` re-enrols a host. It takes `-` for stdin too and keeps an existing runtime config.

`boxCapacity` sits in `runtime.json`, between 1 and 256, 8 by default. A small host gets a lower `boxCapacity` at install, and placement counts its slots from that number. Firecracker runs without its jailer, because the jailer needs root. The installer pins Firecracker for x86_64 only for now.

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
