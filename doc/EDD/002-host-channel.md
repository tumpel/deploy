# EDD-002: Host channel

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

Each host keeps one persistent two-way connection to the control plane, and the host always opens it. TypeSpec defines the protocol without reference to a transport. It covers the handshake, messages, ordering, heartbeats, close codes and budgets. Cloudflare is the first backend, with one Durable Object per host holding a hibernating WebSocket.

## Handshake

The control plane sends a Challenge with a nonce. The host answers with a Hello. Its Ed25519 host key signs `tumpel-channel-hello-v1`, a zero byte, the nonce, a zero byte and the host id. The control plane checks the signature against the key it stored at enrolment and answers Welcome. Challenge, Hello, Welcome and Heartbeat travel outside the numbered frames.

| Close code | Meaning                        |
| ---------- | ------------------------------ |
| 4400       | Protocol error                 |
| 4401       | Bad signature                  |
| 4403       | Host revoked                   |
| 4408       | Heartbeat deadline passed      |
| 4409       | Replaced by a newer connection |
| 4426       | Unsupported protocol version   |

## Messages

The control plane sends TurnOffer, TurnWithdrawn, SnapshotRequest and BoxTeardown. A TurnOffer carries the turn, the session, the box id, the harness, the prompt, the turn's credential grant, the session's last line number and download URLs for the session's snapshots. The host sends TurnClaim, TurnRepositoryReady, TurnLine, TurnComplete, TurnFailed, SnapshotDone, SnapshotFailed, BoxGone and BoxTeardownFailed.

## Ordering and reconnect

Every frame carries `seq` and `ack`. Both counters survive a supervisor restart. A supervisor that lost them exits with `ChannelStateLost`. After Welcome, each side resends every frame the other has not acknowledged, and the receiver drops a `seq` it already holds. The control plane mints a fresh credential grant for every send and resend. For a turn the host already claimed or that already ended, it sends TurnWithdrawn in place of the offer.

A side sends a Heartbeat after 10 s of silence. After 30 s of silence, it closes with 4408. The supervisor reconnects with a backoff from 1 s to 30 s.

## Budgets and named failures

Each budget runs as one timer of its session and ends with the turn.

| Budget              | Value   | Failure                   |
| ------------------- | ------- | ------------------------- |
| Claim               | 60 s    | NotClaimed                |
| First line          | 120 s   | NoFirstOutput             |
| Whole turn          | 3,600 s | TurnTimedOut              |
| Host reconnect      | 30 s    | HostOffline               |
| Credential handover | 300 s   | DispatchCredentialExpired |

The first line counts from TurnRepositoryReady, which the host sends once the box holds the repository. Before it, the clone runs within the image's cloneSeconds and fails RepositoryCloneFailed (EDD-001), and the first line is due within turnCloneBudgetSeconds plus turnFirstLineBudgetSeconds of the claim, so a lost TurnRepositoryReady still ends the turn NoFirstOutput.

A turn also fails BoxBootFailed, PoolExhausted, HarnessExited, HarnessReportedError, CredentialRefused, SnapshotUnreadable or TranscriptGap. CredentialRefused means the provider refused the credential. Every failure carries a detail that states what failed and what fixes it, with the tail of the harness's standard error when the harness wrote any. The budgets sit in one schema-checked settings object of the control plane.

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
