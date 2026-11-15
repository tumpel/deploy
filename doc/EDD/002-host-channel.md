# EDD-002: Host channel

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

Each host keeps one persistent two-way connection to the control plane, and the host always opens it. TypeSpec defines the protocol without reference to a transport. It covers the handshake, messages, ordering, heartbeats, close codes and budgets. Cloudflare is the first backend, with one Durable Object per host holding a hibernating WebSocket.

## Handshake

The control plane sends a Challenge with a nonce. The host answers with a Hello. Its Ed25519 host key signs `tumpel-channel-hello-v1`, a zero byte, the nonce, a zero byte and the host id. The control plane checks the signature against the key it stored at enrolment and answers Welcome. Hello and Welcome carry `protocolVersion`, now 7. The control plane checks `protocolVersion` before the rest of the Hello. It closes a Hello on any other version with UnsupportedVersion, and the reason tells the host to update the supervisor. Hello also carries the host's `boxCapacity` and its usage: warm boxes, the one-minute load average and available memory in MiB. The tenant writes both to its `host_usage` table before the control plane reads the host Online. Challenge, Hello, Welcome and Heartbeat travel outside the numbered frames.

| Close code | Meaning                        |
| ---------- | ------------------------------ |
| 4400       | Protocol error                 |
| 4401       | Bad signature                  |
| 4403       | Host revoked                   |
| 4408       | Heartbeat deadline passed      |
| 4409       | Replaced by a newer connection |
| 4426       | Unsupported protocol version   |

## Messages

The control plane sends TurnOffer, TurnWithdrawn, SnapshotRequest, BoxTeardown and BoxDiscard. A TurnOffer carries the turn, the session, the box id, the harness, the prompt, the turn's credential grant, the session's last line number and a download URL for the session's latest snapshot. The host sends TurnClaim, TurnRepositoryReady, TurnLine, TurnComplete and TurnFailed. It also sends TurnRepositoryCloneFailed, SnapshotDone, SnapshotFailed, BoxGone and BoxTeardownFailed. BoxDiscard tells a host to drop a session's box after the session moved, even when the box holds unsaved changes. The host answers BoxGone. BoxTeardown and BoxDiscard act only on the box they name.

Three exchanges move snapshot chunks (EDD-004). The host sends SnapshotChunks, SnapshotPacks and RestoreChunks. The control plane answers SnapshotChunksHeld, SnapshotPackUploads and RestoreDownloads. Each exchange runs in lockstep parts of up to 500 chunks: the host sends the next part only after the answer to the last one arrives. So the control plane's ledger never holds more than one unanswered reply. The host channel sends the tenant's reply from inside the same blocking section that forwarded the message, because a call back into the blocked object deadlocks.

## Ordering and reconnect

Every frame carries `seq` and `ack`. Both counters survive a supervisor restart. A supervisor that lost them exits with `ChannelStateLost`. After Welcome, each side resends every frame the other has not acknowledged, and the receiver drops a `seq` it already holds. The control plane mints a fresh credential grant for every send and resend. For a turn the host already claimed or that already ended, it sends TurnWithdrawn in place of the offer. The control plane checks each host frame against the host its turn ran on. It acknowledges and ignores a frame for a turn whose session has since moved, and a teardown answer for the session's earlier box.

The host sends a Heartbeat with its usage every 10 s after Welcome, and the tenant updates its `host_usage` row. After 10 s of silence, the control plane sends its own Heartbeat. After 30 s of silence, a side closes with 4408. The supervisor reconnects with a backoff from 1 s to 30 s.

## Budgets and named failures

Each budget runs as one timer of its session and ends with the turn.

| Budget              | Value   | Failure                   |
| ------------------- | ------- | ------------------------- |
| Claim               | 60 s    | NotClaimed                |
| First line          | 120 s   | NoFirstOutput             |
| Whole turn          | 3,600 s | TurnTimedOut              |
| Host reconnect      | 30 s    | HostOffline               |
| Credential handover | 300 s   | DispatchCredentialExpired |

The first line counts from TurnRepositoryReady, which the host sends once the box holds the repository. Before it, the clone runs within the image's cloneSeconds, which the host sends on TurnClaim. Until then, the first line is due by the claim time plus cloneSeconds plus turnFirstLineBudgetSeconds. The host reports a failed clone as TurnRepositoryCloneFailed (EDD-001). A lost TurnRepositoryReady still ends the turn NoFirstOutput.

A turn also fails BoxBootFailed, PoolExhausted, HarnessExited, HarnessReportedError, CredentialRefused, SnapshotUnreadable or TranscriptGap. When the harness ends with an error result, the turn fails. A refused credential fails it CredentialRefused. Any other error fails it HarnessReportedError with the harness's text, capped at 2 KiB. The turn keeps the first error result. One without text gives its subtype, or states that it carries neither text nor subtype. Every failure carries a detail that states what failed and what fixes it, with the tail of the harness's standard error when the harness wrote any. The budgets sit in one schema-checked settings object of the control plane.

## Backends

A backend provides:

- accepting a connection
- sending a frame
- closing with a code
- one timer per host
- a store for unacknowledged frames

The Cloudflare backend uses a Durable Object per host with one alarm. A second backend, such as API Gateway WebSockets with Lambda, implements the same interface.

## FAQ

**Does a message survive a dropped connection?** Yes. The sender resends it after the next Welcome.

**Can a revoked host reconnect?** No. The control plane closes it with 4403.
