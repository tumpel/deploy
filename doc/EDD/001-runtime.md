# EDD-001: Runtime

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

The supervisor runs each session in a Firecracker microVM, the box, on a tenant's Linux host with KVM. A box boots from a read-only image shared by digest and keeps the session's own files on a separate writable drive. Between turns, the supervisor pauses the box for the warm window and tears it down after the window, once a snapshot holds its last turn. `tumpel-supervisor install` prepares the host once with sudo, and from then on the supervisor runs as an ordinary user.

## Box lifecycle

A box boots from a base image, a kernel, a harness layer and the supervisor's guest drive, each named by digest (EDD-007). The supervisor refuses a guest whose greeting, GuestHello, names another harness than the offer. GuestHello also carries `protocolVersion`. On a version outside `GuestProtocol.Oldest` to `GuestProtocol.Version` the turn fails BoxBootFailed, and the detail names both and says to rebuild the image.

A second drive per session holds the overlay upper directory, which the guest's init mounts over the image before it starts the guest agent. A cold boot of a session with snapshots attaches one more read-only drive with the restored files (EDD-004). The agent dials the host over vsock once ready and speaks length-prefixed JSON.

Claude Code and every other harness that reads turns as a stream gets one process per box. One that reads one prompt per process gets one process per turn. A process stays in use while the model, the exported variables and the persona's files stay the same. The harness runs as root with full permissions.

Each turn offer carries the persona's file list with a download URL per digest. The supervisor caches the files by digest and passes them to the guest over vsock. The guest writes them under the harness home before the harness starts. A host chunk cache under `imageCacheDir/chunks` keeps snapshot chunks by digest (EDD-004).

## Guest images

Each turn offer names a guest image of the current release (EDD-002). The supervisor boots a box only from its image cache, `imageCacheDir`. When the cache lacks the image, the supervisor sends TurnImageFetching before the claim and downloads the image, kernel and manifest one at a time. Each file lands under a temporary name and moves into place once its sha256 matches. The cache keeps base images, harness layers and the guest drive as EDD-007 describes. Kernels are shared by digest, and a kernel the cache holds is not fetched again. The release's kernel is the only kernel. A warm box keeps the image it booted from.

The fetch budget is `turnImageFetchBudgetSeconds` in `ControlPlaneSettings`; EDD-002 lists its value and failure. A download that fails, misses its digest or names another image in its manifest fails the turn ImageFetchFailed. A release without an image for the host's architecture fails it ImageNotReleased.

## Repository

The images carry pinned git and gh. Before the harness starts, the guest clones the session's repository into `/root/workspace`. It skips the clone when the repository is there already. Git reads `GITHUB_TOKEN` through a credential helper, so the token stays out of the URL and off the disk. gh reads the token as `GH_TOKEN`. Commits carry the offer's `gitAuthorName` and `gitAuthorEmail`, which follow the repository credential source (EDD-003). `GitHubApp` commits as the App's bot `<app-slug>[bot]`, with the email `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`. `SecretSet` commits as the GitHub user of the set's `GITHUB_TOKEN`, with the email `<id>+<login>@users.noreply.github.com`. The control plane reads that user with GET `/user` once, when the `GITHUB_TOKEN` member is written, and stores it with the set. It refuses the write when GitHub refuses the token. Nobody enters a git identity.

The clone runs within the image's `cloneSeconds`, 120 s. A clone that fails or runs out of time arrives as `TurnRepositoryCloneFailed`, with what git reported and a cause: `Refused`, `TimedOut`, `DirectoryNotEmpty` or `Other`. The turn then fails `RepositoryCloneFailed`. EDD-002 times the first line from `TurnRepositoryReady`.

## Warm window

Turns for different sessions run in parallel. When a turn ends, the supervisor pauses the box's vCPUs and arms a timer for `warmWindowSeconds` from the host's runtime config, 900 s by default. A turn inside the window that names the box cancels the timer and resumes the paused process. A turn that names another box gets a fresh one, and the supervisor stops the warm box. Once the timer has fired and the box's last turn is in a snapshot, the supervisor stops the box and deletes its drive. A session stop ends the window early with BoxTeardown (EDD-004).

The warm state is the paused process in host memory. The supervisor writes no memory file to disk.

## Placement

The supervisor reads its usage from /proc: warm boxes, the one-minute load average and `MemAvailable` in MiB. When it cannot, it exits `UsageUnreadable`, code 7. It sends that usage and its `boxCapacity` over the channel (EDD-002). The tenant's Durable Object keeps the latest per host in its `host_usage` table and places one request at a time.

A host's free slots are its `boxCapacity`, minus the tenant's `Offered` and `Running` turns on it, minus its warm boxes. A host is Full when those turns reach its `boxCapacity`. Warm boxes never make a host Full: its supervisor evicts one as Networking describes. The tenant picks an Online host that is not Full and whose architecture has a base and the session's harness layer in the current release. It picks the least busy of those, by the sum of three shares: running and warm boxes over `boxCapacity`, the one-minute load over the host's CPUs, and the memory in use over the host's memory. The running turns count at once, so two starts in a row spread before the next Heartbeat. A tie goes to the host with the most free slots. A large host that swaps under many boxes thus loses to an idle small host. A persona's `boxMemoryMib`, 2048 MiB by default and settable from 512 to 65536 MiB, sizes each box's memory. Only a persona whose `boxMemoryMib` is above the default also needs a host whose available memory holds that much; at the default the memory never refuses a host, since warm boxes are evictable and Firecracker fills a box's memory lazily. A persona's `boxDiskMib`, 32768 MiB by default, sizes each box's disk, a sparse file. The host reports its disk budget and, as held, the disk of the boxes it cannot evict on each Heartbeat; an idle box whose last turn is in a snapshot is evictable, as for memory. Placement skips a host whose held disk plus the box's would pass its budget, unless it holds none, and adds the share of the budget held to the busyness, so a held turn moves to a host with disk room. The host still refuses a box whose disk does not fit `PoolExhausted` before it boots, and a turn still Offered at its deadline ends `Undelivered` and names the last refusal. A turn the harness completed on a nearly full disk stays Completed, and its read carries a warning with the disk's size and the `boxDiskMib` that raises it.

With every host Full, the tenant refuses the start `PoolExhausted` and lists each host's reason. With no host at all, the tenant refuses it `NoHostAvailable`. A start on an Online host that has sent no usage yet is refused with the host's name and the fix: restart `tumpel-supervisor run` there, so that its Hello carries its usage. `tumpel host list-usage` lists the slots, load and memory of each host that has connected, leaving out revoked hosts.

## Moving a session

A placed session keeps its host, and each turn records its host. A send stays there while the host is Online. When the host is not Online and a completed turn is newer than the latest snapshotted turn, the tenant refuses the send `HostOffline` and names the host and the missing turns. Otherwise the tenant places the session as it places a new one. It fails the session's pending snapshot requests `NotAnswered` and sends BoxDiscard to the old host, unless the session is Stopped. A fresh box then boots on the new host from the latest snapshot. A stop is refused `HostOffline` while the host is offline.

## Host setup

A fresh host fetches the supervisor binary with `curl -fL <origin>/v1/releases/supervisor/Amd64`. Adding the host is then one command over ssh. `tumpel host mint-token` mints a one-time enrolment token, and `tumpel-supervisor install --endpoint <stage origin> --token-file <path|->` sets the host up, enrols it and starts the unit. The token comes from a file or from stdin (`-`), so it stays off the command line. Sudo runs for the installer only. The supervisor never asks for admin rights. The appendix lists the installer's nine steps.

## Running host

A supervisor that fails restarts after 5 s. Exit codes 3 (NotEnrolled) and 5 (HostRevoked) stop it for good. Exit code 6 (ProtocolError) means the supervisor needs an update, so the unit waits 60 s before each restart.

`install` without `--endpoint` and `--token-file` only sets up the host, and restarts the unit when the host is enrolled. `tumpel-supervisor enrol` re-enrols a host. It takes `-` for stdin too and keeps an existing runtime config.

`boxCapacity` sits in `runtime.json`, between 1 and 256, 8 by default. A small host gets a lower one at install. Firecracker runs without its jailer, because the jailer needs root. The installer pins Firecracker for x86_64 only.

## Networking and isolation

Each box claims the lowest free device `tumpel<k>`, takes guest IP 172.16.<k>.2 and its own MAC, and returns the device at teardown. When every device is taken, the supervisor evicts the longest-paused box that has nothing left to snapshot. With no such box, the turn fails `PoolExhausted`, naming the capacity and the boxes held.

The host masquerades the box's traffic to the internet. The guest filter drops forwarded traffic from a source outside 172.16.0.0/16. It also drops forwarded traffic to the LAN, the hypervisor and every other box: 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12 and 192.168.0.0/16. On the host itself, the filter drops every packet a box sends, so a box reaches no host service. IPv6 forwarding is off. Guest name lookups go to 1.1.1.1 and 9.9.9.9.

## FAQ

**Does the supervisor ever need root?** No. The installer does the privileged work once.

**What does a box hold after teardown?** Nothing. The session lives on in its snapshots.

## Appendix of measured numbers

Measured on the reference host: a nested KVM guest with 4 vCPU and 8 GiB.

| Step                                   | Time   |
| -------------------------------------- | ------ |
| First guest serial line                | 159 ms |
| Guest agent ready over vsock           | 2.8 s  |
| vsock round trip, median               | 8 ms   |
| Cold boot plus one turn, Shell harness | 2.6 s  |

Guest random reads at 4 KiB and queue depth 1 reach about 11,000 IOPS, 50 percent of the host filesystem. The guest block path sets that cap. Bare metal is not measured.

## Appendix of installer steps

The installer:

1. refuses a host that is already enrolled, before any setup step;
2. tries `sudo -n`, then asks for the password on a terminal. Without one it stops and names two fixes: the NOPASSWD sudoers line, or a run from a terminal with the token in a file;
3. adds the supervisor's user to the `kvm` group, restarts the user manager and checks once that the group can read and write `/dev/kvm`;
4. writes the runtime config, `runtime.json`;
5. installs Firecracker at a pinned version, checked against its digest;
6. installs the guest filter as a unit that loads before the host network comes up;
7. makes `boxCapacity` TAP devices owned by that user, where device `tumpel<k>` has gateway 172.16.<k>.1/30, and masquerades their traffic in the guest filter table. A server cloud image runs systemd-networkd, which makes the devices. A desktop runs NetworkManager without networkd; there a oneshot unit makes them with `ip tuntap` at boot, and a NetworkManager config file leaves `tumpel*` devices unmanaged. Both are host targets. The installer never turns networkd on;
8. installs the supervisor binary and a lingering user unit that runs `tumpel-supervisor run` after the rollback check of EDD-008;
9. enrols the host and starts the unit.
