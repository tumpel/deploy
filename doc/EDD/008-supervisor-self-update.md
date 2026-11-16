# EDD-008: Supervisor self-update

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md). It covers OR-6 and OR-7.

## Summary

The supervisor replaces its own binary when the release names a new one. It first runs the new binary in a check mode while the old one keeps serving. Only a binary that passes takes over, and only on a host with no box. The new binary starts on trial. If it fails to start, misses Welcome or stops for any reason before Welcome, the next start puts the old binary back.

## Trigger

The supervisor reads `GET /v1/releases/current` at four moments:

1. At each Welcome, so a host that starts idle updates at once.
2. When the control plane sends ReleasePublished, so an idle host updates without a reconnect.
3. When its box count drops to 0.
4. At once, when the control plane closes the channel with 4426 (UnsupportedVersion).

It compares the release sha256 for its architecture with the sha256 of the binary it runs from. Nothing else starts an update.

ReleasePublished comes from the release bucket. A write of `current.json` there raises an object event on the queue `tumpel-releases-<stage>`. The queue holds each event for 60 s, past the control plane's 30 s release cache, so every host reads the new release. The control plane consumes the queue and sends ReleasePublished to every Online host within 30 s, or fails ReleaseNoticeTimedOut. The message travels outside frames and is never resent. A host that misses it reads the release at its next Welcome. A supervisor that predates the message closes the channel with ProtocolError on it, and the Welcome of its reconnect reads the release.

## Phases

| Phase   | Limit | Failure                          |
| ------- | ----- | -------------------------------- |
| Fetch   | 330 s | SupervisorUpdateFetchFailed      |
| Verify  | 30 s  | SupervisorUpdateChecksumMismatch |
| Dry run | 60 s  | SupervisorUpdateDryRunFailed     |
| Swap    | 30 s  | SupervisorUpdateSwapFailed       |
| Trial   | 120 s | SupervisorUpdateRolledBack       |

1. **Fetch.** The supervisor reads the release in 30 s. It then downloads the binary through the 302 of `GET /v1/releases/supervisor/{architecture}` in 300 s.
2. **Verify.** The bytes must hash to the release sha256.
3. **Dry run.** The old binary keeps serving while `tumpel-supervisor.candidate check` runs. The check runs the start path of `run`: it hashes its own binary, loads the enrolment, the host key and `runtime.json`, and builds the HTTP client and the TAP pool. It leaves the update state alone, and it does not probe `/dev/kvm` or Firecracker. It then dials the channel and closes after the Challenge, before Hello. It prints its channel and guest protocol versions and exits 0. The channel protocol must match the release. A passing candidate stays on disk until the host runs no box. A failed dry run leaves the running binary untouched.
4. **Swap.** The supervisor asks the box lifecycle to claim the host as idle. The lifecycle grants the claim only while no box runs, warm or busy. The supervisor then sends the Restarting step, and the control plane reads the host Offline, so placement routes new turns past it. From the claim on, the lifecycle answers every TurnOffer TurnFailed HostUpdating, and the control plane offers that turn to another host at once; with no other host, or a session whose turns lack a snapshot, the turn fails HostUpdating. A failed swap releases the claim. The supervisor copies its binary to `tumpel-supervisor.previous` and writes `update-pending.json`. It renames the candidate over its binary and exits 9. systemd then starts the new binary.
5. **Trial.** The unit's `ExecStartPre` shell owns the trial, before each start. When `update-trial.json` exists, the shell copies `.previous` over the binary, syncs it, moves it into place and renames the file to `update-rolled-back.json`. Otherwise, when `update-pending.json` exists, the shell renames it to `update-trial.json`. So the new binary is on trial before it runs a single instruction. At Welcome it reports Online and deletes `update-trial.json`. A miss of Welcome within 120 s fails UpdateNotOnline. While `update-trial.json` exists, every failure of `run` exits 10 (UpdateNotOnline), so systemd always restarts the unit. A crash, a reboot or a `systemctl stop` during the trial leaves the file in place, so the next start rolls back and refuses that binary. The restored binary reports SupervisorUpdateRolledBack and deletes `update-rolled-back.json`.

A failed dry run, a failed swap or a rollback writes the candidate's sha256 to `update-refusal.json`. The supervisor skips that sha256 until the release names another. A failed fetch or verify starts over at the next trigger. When `update-refusal.json` does not parse, the host sends SupervisorUpdateStateUnreadable, and updates stop until someone deletes the file. When `update-trial.json` names another binary than the one running, the supervisor deletes it at start.

## Host events

Each phase the host enters sends SupervisorUpdateStep. Each failure sends SupervisorUpdateFailed. Both name the running and the candidate sha256. A failed dry run carries the last 20 lines the candidate printed. Every token-shaped run in those lines is hidden, and so is every one in `detail`. Errors from the HTTP client drop their URL, so a presigned download URL never reaches `detail`. The control plane reads the host Offline on the Restarting step and reads its presence again on every other step and failure, so a failed swap brings the host back Online. The tenant keeps the latest step and the latest failure per host. Host carries them as `supervisorUpdateStep` and `supervisorUpdateFailure`, and the dashboard host page shows them in plain words.

## Layout

| Path                                                       | Holds                     |
| ---------------------------------------------------------- | ------------------------- |
| `~/.local/bin/tumpel-supervisor`                           | The running binary        |
| `~/.local/bin/tumpel-supervisor.previous`                  | The binary it replaced    |
| `~/.local/bin/tumpel-supervisor.candidate`                 | A binary in its dry run   |
| `~/.local/state/tumpel-supervisor/update-pending.json`     | A swap before its restart |
| `~/.local/state/tumpel-supervisor/update-trial.json`       | A new binary on trial     |
| `~/.local/state/tumpel-supervisor/update-rolled-back.json` | A rollback to report      |
| `~/.local/state/tumpel-supervisor/update-refusal.json`     | The refused sha256        |

The installer writes the user unit with `ExecStart=<binary> run` and the rollback shell in `ExecStartPre`. A binary that reaches Welcome on trial rewrites the unit to that text when it differs and reloads systemd, so a host installed with the older `run --update-binary` unit moves to the shell-owned trial on its first update. Under that older unit no shell marks the trial, so the binary takes an `update-pending.json` naming itself as its trial, and `run` accepts and ignores `--update-binary`. The shell finds the state directory the way the supervisor does: `TUMPEL_SUPERVISOR_DIR`, then `XDG_STATE_HOME`, then `~/.local/state`.

## Release order

A new host message, such as a new SupervisorUpdateFailureReason, must reach the control plane before any supervisor sends it. Workers Builds deploys the control plane from main. `release.yml` publishes the supervisor from the same push. So a change that adds a host message lands in one commit, and that commit's Workers Builds deploy must finish before `release.yml` publishes. Until then the control plane closes the channel with ProtocolError on the unknown message, and the host reconnects and sends it again.

The release notice follows the same order. Workers Builds deploys the queue consumer and its ReleasePublished sender before `release.yml` writes `current.json`, so the event of each release reaches a consumer that handles it. `npm run deploy:infra` creates the queue and the bucket's event notification, and the Workers Builds deploy applies them too.

## FAQ

**Why not test the new binary after the swap?** A broken binary then drops the host's boxes and its channel. The dry run costs one extra start and keeps the old binary serving.

**Does an update kill a running turn?** No. The lifecycle grants the idle claim only with no box. A turn already on its way when the host claims idle is refused HostUpdating and offered to another host.

**Why does the check stop before Hello?** A Welcome replaces the host's open connection, and the check shares the host's channel state.

**What if the new binary dies before it runs any code?** The next start rolls it back. The shell marks the trial before the binary starts, so no crash can skip it.

**What does a bad release cost?** One failed dry run per host, shown on the host page, and no restart.
