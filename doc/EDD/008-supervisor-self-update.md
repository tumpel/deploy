# EDD-008: Supervisor self-update

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md). It covers OR-6 and OR-7.

## Summary

The supervisor replaces its own binary when the release names a new one. It first runs the new binary in a check mode while the old one keeps serving. Only a binary that passes takes over, and only between boxes. A new binary that does not come Online in time gives way to the one it replaced, which systemd starts again.

## Trigger

After each Welcome and each TurnOffer, the supervisor reads `GET /v1/releases/current`. It compares the release sha256 for its architecture with the sha256 of its own binary. A close with 4426 (UnsupportedVersion) starts the same path at once. Nothing else starts it.

## Phases

| Phase     | Limit   | Failure                          |
| --------- | ------- | -------------------------------- |
| Fetch     | 330 s   | SupervisorUpdateFetchFailed      |
| Verify    | 30 s    | SupervisorUpdateChecksumMismatch |
| Dry run   | 60 s    | SupervisorUpdateDryRunFailed     |
| Wait idle | 3,600 s | SupervisorUpdateIdleTimedOut     |
| Swap      | 30 s    | SupervisorUpdateSwapFailed       |
| Online    | 120 s   | SupervisorUpdateRolledBack       |

1. **Fetch.** The supervisor reads the release in 30 s, then downloads the binary through the 302 of `GET /v1/releases/supervisor/{architecture}` in 300 s.
2. **Verify.** The bytes must hash to the release sha256.
3. **Dry run.** The old binary keeps serving while `tumpel-supervisor.candidate check` runs. The check loads the enrolment, the host key and `runtime.json`. Next come the image cache, `/dev/kvm` and `firecracker --version`. It dials the channel and closes after the Challenge, before Hello. The check prints its channel and guest protocol versions and exits 0. The channel protocol must match the release. A failed dry run leaves the running binary untouched.
4. **Wait idle.** The swap waits until the host runs no box, warm or busy.
5. **Swap.** The supervisor copies its binary to `tumpel-supervisor.previous` and writes `update-pending.json` with an Online deadline. It renames the candidate over its binary and exits 9, and systemd restarts it.
6. **Online.** The new binary reports Online at Welcome and deletes `update-pending.json`. Past the deadline it exits UpdateNotOnline. Before each start, systemd runs `tumpel-supervisor.previous rollback`, which past the deadline puts the old binary back. The restored binary reports SupervisorUpdateRolledBack.

A failed dry run, a failed swap or a rollback writes the candidate's sha256 to `update-refusal.json`. The supervisor skips that sha256 until the release names another. A failed fetch, verify or wait starts over at the next trigger.

## Host events

Each phase the host enters sends SupervisorUpdateStep. Each failure sends SupervisorUpdateFailed. Both name the running and the candidate sha256. A failed dry run carries the last 20 lines the candidate printed, with every token-shaped run hidden. The tenant keeps the latest five of each per host. The dashboard host page shows the update state and the last failure in plain words.

## Layout

| Path                                             | Holds                    |
| ------------------------------------------------ | ------------------------ |
| `~/.local/bin/tumpel-supervisor`                 | The running binary       |
| `~/.local/bin/tumpel-supervisor.previous`        | The binary it replaced   |
| `~/.local/bin/tumpel-supervisor.candidate`       | A binary in its dry run  |
| `~/.local/state/tumpel-supervisor/update-*.json` | Pending swap and refusal |

The installer writes the user unit with `run --update-binary <path>` and the rollback `ExecStartPre`. A supervisor started without `--update-binary` never updates itself.

## FAQ

**Why not test the new binary after the swap?** A broken binary then drops the host's boxes and its channel. The dry run costs one extra start and keeps the old binary serving.

**Does an update kill a running turn?** No. The swap waits for a host with no box.

**Why does the check stop before Hello?** A Welcome replaces the host's open connection, and the check shares the host's channel state.

**What does a bad release cost?** One failed dry run per host, shown on the host page, and no restart.
