# EDD-008: Supervisor self-update

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md). It covers OR-6 and OR-7.

## Summary

The supervisor replaces its own binary when the release names a new one. It first runs the new binary in a check mode while the old one keeps serving. Only a binary that passes takes over, and only on a host with no box. The new binary starts on trial. If it fails to start or misses Welcome, systemd puts the old binary back.

## Trigger

The supervisor reads `GET /v1/releases/current` at three moments:

1. At each Welcome, so a host that starts idle updates at once.
2. When its box count drops to 0.
3. At once, when the control plane closes the channel with 4426 (UnsupportedVersion).

It compares the release sha256 for its architecture with the sha256 of the binary it runs from. Nothing else starts an update.

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
3. **Dry run.** The old binary keeps serving while `tumpel-supervisor.candidate check` runs. The check runs the start path of `run`: it hashes its own binary, reads the update state, loads the enrolment, the host key and `runtime.json`, and builds the HTTP client and the TAP pool. It then dials the channel and closes after the Challenge, before Hello. It prints its channel and guest protocol versions and exits 0. The channel protocol must match the release. A passing candidate stays on disk until the host runs no box. A failed dry run leaves the running binary untouched.
4. **Swap.** The supervisor asks the box lifecycle to claim the host as idle. The lifecycle grants the claim only while no box runs, warm or busy, and then refuses every new box with PoolExhausted. The supervisor copies its binary to `tumpel-supervisor.previous` and writes `update-pending.json`. It renames the candidate over its binary and exits 9. systemd then starts the new binary.
5. **Trial.** The new binary renames `update-pending.json` to `update-trial.json` as it starts. At Welcome it reports Online and deletes `update-trial.json`. Any start failure before Welcome exits UpdateNotOnline, and so does a miss of Welcome within 120 s. Before each start, the unit's `ExecStartPre` checks for `update-trial.json`. When the file is there, the shell copies `.previous` over the binary and renames the file to `update-rolled-back.json`. The restored binary reports SupervisorUpdateRolledBack and deletes that file.

A failed dry run, a failed swap or a rollback writes the candidate's sha256 to `update-refusal.json`. The supervisor skips that sha256 until the release names another. A failed fetch or verify starts over at the next trigger. When `update-refusal.json` does not parse, the host sends SupervisorUpdateStateUnreadable, and updates stop until someone deletes the file. When `update-pending.json` names another binary, the supervisor deletes it at start.

## Host events

Each phase the host enters sends SupervisorUpdateStep. Each failure sends SupervisorUpdateFailed. Both name the running and the candidate sha256. A failed dry run carries the last 20 lines the candidate printed. Every token-shaped run in those lines is hidden, and so is every one in `detail`. Errors from the HTTP client drop their URL, so a presigned download URL never reaches `detail`. The tenant keeps the latest step and the latest failure per host. Host carries them as `supervisorUpdateStep` and `supervisorUpdateFailure`, and the dashboard host page shows them in plain words.

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

The installer writes the user unit with `ExecStart=<binary> run` and the rollback shell in `ExecStartPre`. The shell finds the state directory the way the supervisor does: `TUMPEL_SUPERVISOR_DIR`, then `XDG_STATE_HOME`, then `~/.local/state`.

## Release order

A new host message, such as a new SupervisorUpdateFailureReason, must reach the control plane before any supervisor sends it. Workers Builds deploys the control plane from main. `release.yml` publishes the supervisor from the same push. So a change that adds a host message lands in one commit, and that commit's Workers Builds deploy must finish before `release.yml` publishes. Until then the control plane closes the channel with ProtocolError on the unknown message, and the host reconnects and sends it again.

## FAQ

**Why not test the new binary after the swap?** A broken binary then drops the host's boxes and its channel. The dry run costs one extra start and keeps the old binary serving.

**Does an update kill a running turn?** No. The lifecycle grants the idle claim only with no box, and refuses new boxes once the swap starts.

**Why does the check stop before Hello?** A Welcome replaces the host's open connection, and the check shares the host's channel state.

**What if the new binary dies before it marks its trial?** Then nothing rolls it back, and systemd restarts it in a loop. The dry run runs the same start path first, which keeps such a binary off the host.

**What does a bad release cost?** One failed dry run per host, shown on the host page, and no restart.
