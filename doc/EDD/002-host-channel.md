# EDD-002: Host channel

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

Each host keeps one persistent two-way connection to the control plane, and the host always opens it. TypeSpec defines the protocol without reference to a transport. It covers the handshake, messages, ordering, heartbeats, close codes and budgets. Cloudflare is the first backend, with one Durable Object per host holding a hibernating WebSocket.

## Handshake

The control plane sends a Challenge with a nonce. The host answers with a Hello. Its Ed25519 host key signs `tumpel-channel-hello-v1`, a zero byte, the nonce, a zero byte and the host id. The control plane checks the signature against the key it stored at enrolment and answers Welcome. Hello and Welcome carry `protocolVersion`, and the control plane accepts every version from `ChannelProtocol.Oldest` to `ChannelProtocol.Version` (EDD-009). `npm run generate` checks the channel wire shape against the lock at `git merge-base HEAD origin/main`, fetching `origin/main` when the checkout lacks it; in a shallow CI checkout, where that history is missing, it compares against the lock on `origin/main`. A baseline it cannot read fails the run. The control plane checks `protocolVersion` before the rest of the Hello. It closes a Hello on a version outside that window with UnsupportedVersion, and the reason tells the host to update the supervisor. Hello also carries the host's `boxCapacity` and its usage: warm boxes, the one-minute load average and available memory in MiB. The tenant writes both to its `host_usage` table before the control plane reads the host Online. Challenge, Hello, Welcome and Heartbeat travel outside the numbered frames.

| Close code | Meaning                        |
| ---------- | ------------------------------ |
| 4400       | Protocol error                 |
| 4401       | Bad signature                  |
| 4403       | Host revoked                   |
| 4408       | Heartbeat deadline passed      |
| 4409       | Replaced by a newer connection |
| 4426       | Unsupported protocol version   |

## Messages

The control plane sends TurnOffer, TurnWithdrawn, SnapshotRequest, BoxTeardown and BoxDiscard. A TurnOffer carries the turn, the session, the box id, the harness, the prompt, the turn's credential grant, the session's last line number and a download URL for the session's latest snapshot. It also carries the guest image: its image, kernel and manifest digests, a presigned URL for each and `fetchSeconds`, the fetch budget, plus the harness layer's digests and URLs (EDD-007). The host sends TurnImageFetching, TurnClaim, TurnRepositoryReady, TurnLine, TurnComplete and TurnFailed. It also sends TurnRepositoryCloneFailed, SnapshotDone, SnapshotFailed, BoxGone and BoxTeardownFailed. BoxDiscard tells a host to drop a session's box after the session moved, even when the box holds unsaved changes. The host answers BoxGone. BoxTeardown and BoxDiscard act only on the box they name. A Claude setup (EDD-003) adds ClaudeSetupBoxOffer, ClaudeSetupBoxCode and ClaudeSetupBoxDiscard from the control plane, and ClaudeSetupBoxUrl and ClaudeSetupBoxFailed from the host. The guest protocol carries them on to the box as GuestInput.

Three exchanges move snapshot chunks (EDD-004). The host sends SnapshotChunks, SnapshotPacks and RestoreChunks. The control plane answers SnapshotChunksHeld, SnapshotPackUploads and RestoreDownloads. Each exchange runs in lockstep parts of up to 500 chunks: the host sends the next part only after the answer to the last one arrives. So the control plane's ledger never holds more than one unanswered reply. The host channel handles a host's frames one at a time in arrival order, and sends the tenant's reply before it handles the next frame. It holds no blocking section across the call to the tenant: Cloudflare resets a Durable Object whose blocking section throws or runs past 30 s, and the reset drops the host's WebSocket without a close frame. So a fault fails only the handling of its frame, and the tenant may send to the host while it handles one of its frames.

## Ordering and reconnect

Every frame carries `seq` and `ack`. Both counters survive a supervisor restart. A supervisor that lost them exits with `ChannelStateLost`. After Welcome, each side resends every frame the other has not acknowledged, and the receiver drops a `seq` it already holds. The control plane mints a fresh credential grant for every send and resend. For a turn the host already claimed or that already ended, it sends TurnWithdrawn in place of the offer. The control plane checks each host frame against the host its turn ran on. It acknowledges and ignores a frame for a turn whose session has since moved, and a teardown answer for the session's earlier box. It answers any other frame the tenant cannot place with FrameRefused and the tenant's reason, logs it as FrameRefused, and keeps the connection open. The control plane acknowledges a frame only once the tenant handled it. A fault leaves the frame unacknowledged and the error in the log; the host's next frame then closes the connection with a frame gap, and the resend after Welcome hands the frame to the tenant again. Numbering and storing a frame is one synchronous step, and the control plane prepares a TurnOffer, with its fresh grant, before it numbers it, so frames leave in sequence order.

The host sends a Heartbeat with its usage every 10 s after Welcome, and the tenant updates its `host_usage` row. After 10 s of silence, the control plane sends its own Heartbeat. After 30 s of silence, a side closes with 4408. The supervisor reconnects with a backoff from 1 s to 30 s.

Each Heartbeat also names every session the host holds a box for. The supervisor reads that list, then sends every message its boxes queued before it, and only then the Heartbeat. So the first Heartbeat after Welcome follows the host's resent frames. On that Heartbeat the control plane fails each Running turn on the host whose session the list does not name with BoxLost, and the session goes Idle and takes its next turn. It compares in the same one-at-a-time handling as a frame, so no frame lands halfway. A turn the host finished while disconnected reaches the control plane first and keeps its own outcome. A host on channel protocol 18 to 21 sends no list and reports nothing.

## Budgets and named failures

Each budget runs as one timer of its session and ends with the turn.

| Budget              | Value   | Failure                   |
| ------------------- | ------- | ------------------------- |
| Image fetch         | 900 s   | ImageFetchTimedOut        |
| First line          | 120 s   | NoFirstOutput             |
| Delivery            | 3,600 s | Undelivered               |
| Run, from the claim | 3,600 s | TurnTimedOut              |
| Host reconnect      | 30 s    | HostOffline               |
| Credential handover | 300 s   | DispatchCredentialExpired |

The control plane never fails a turn for a slow claim. The turn stays Offered until a host claims it, and the channel resends an unacknowledged offer with a fresh credential grant at the next Welcome. A turn no host claims within `turnTotalBudgetSeconds` of its first offer fails Undelivered, however often it was offered again, the dead letter, which the turn and session reads, the CLI and the dashboard show as an error. The run budget, the same `turnTotalBudgetSeconds`, starts again at the claim. Host reconnect fails only a claimed turn HostOffline; an Offered turn waits for the host. A host that reports NotClaimed, because the answer to its claim did not reach it in time, gets the turn offered again. A host that refuses an Offered turn PoolExhausted holds it until its next Heartbeat. The control plane then places the turn again over every Online host with room, the refusing host included, so an idle host takes it and a full tenant keeps it held. `turnOfferTtlSeconds` sets only how long the credential and URLs of each send stay valid. The channel does not resend an offer the host acknowledged and then lost, for example in a supervisor restart; that turn waits for the dead letter until reconciliation on connect lands (mvhenten/tumpel#189). The host answers an offer it accepts with TurnClaim at once, before it fetches the image, restores the snapshot or boots the box; image fetch, boot and restore keep their own budgets and fail ImageFetchTimedOut, BoxBootFailed or SnapshotUnreadable, and the harness gets the prompt only once TurnClaimed arrived and the box is ready, while a TurnWithdrawn leaves the box warm with nothing started. The first line counts from TurnRepositoryReady, or from the harness start plus the image's cloneSeconds when that never arrives, and a failed clone reaches the control plane as TurnRepositoryCloneFailed (EDD-001).

A turn also fails BoxBootFailed, ImageNotReleased, ImageFetchFailed or PoolExhausted. It can fail HarnessExited, HarnessReportedError, CredentialRefused, SnapshotUnreadable or TranscriptGap. When the harness ends with an error result, the turn fails. A refused credential fails it CredentialRefused. Any other error fails it HarnessReportedError with the harness's text, capped at 2 KiB. The turn keeps the first error result. One without text gives its subtype, or states that it carries neither text nor subtype. Every failure carries a detail that states what failed and what fixes it, with the tail of the harness's standard error when the harness wrote any. The budgets sit in one schema-checked settings object of the control plane.

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
