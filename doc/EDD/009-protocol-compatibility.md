# EDD-009: Protocol compatibility

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md). It adds OR-8 to OR-17 and changes the handshake of [EDD-002](002-host-channel.md) and the release order of [EDD-008](008-supervisor-self-update.md).

## Summary

Each host keeps two connections to the control plane. The small, frozen control channel names the host, the versions each side speaks, and when to update. The data channel carries turns, transcripts and snapshots, and its shape changes with most releases. There, each side names its oldest and newest version, and the pair speaks the newest both know. The control plane keeps one to three data versions side by side. A release drops the oldest only when no counted host speaks it. A host offline past a global grace of 3 days becomes Lapsed and stops counting. Only a release deploys the control plane, after its supervisor publishes and passes the gate.

## Requirements

- **OR-8 Control channel.** Each host keeps a control channel apart from its data channel, and the control plane accepts every control protocol version it ever shipped.
- **OR-9 Side by side.** The control plane accepts every data version from `ChannelProtocol.Oldest` to `ChannelProtocol.Version`, one to three versions.
- **OR-10 Negotiation.** Each data Hello and GuestHello names the sender's oldest and newest version. The answer names the newest version both sides know.
- **OR-11 Newer peers.** A supervisor newer than the control plane, or a guest newer than its supervisor, speaks the older peer's version when its range holds it.
- **OR-12 Drop gate.** A release that raises `ChannelProtocol.Oldest` stops before it deploys while any counted host speaks a lower version.
- **OR-13 Lapsed.** A host Offline for `offlineGraceSeconds`, one value per stage and 259,200 by default, becomes Lapsed. It stops counting and rejoins only after an intervention.
- **OR-14 A refusal keeps the boxes.** A supervisor whose data range misses the control plane's never exits while a box runs, and updates over control. (OR-6)
- **OR-15 Real versions.** Every release carries a semantic version. A tag `vX.Y.Z` cuts a stable release, and an automatic release from main carries a prerelease version.
- **OR-16 Fleet view.** MCP, the CLI and the dashboard read one model of the releases, host counts per version and state, and what blocks raising `Oldest`.
- **OR-17 Deploy on release.** Workers Builds deploys only from the branch `release`, which the runner moves after publish and the gate.

## Control and data channels

The supervisor opens two WebSockets to the host's Durable Object: `/v1/hosts/{hostId}/control` and `/v1/hosts/{hostId}/channel`, the data channel. The control channel opens first. A data protocol error, a frame gap or a 4426 closes only the data socket, so the control plane can still reach the host. The cost is a second signed handshake and a second hibernating socket per host. One socket carrying both, as Heartbeat and ReleasePublished travel outside frames, saves that but lets a data close cut control too (decision 1).

The control channel carries a fixed set, in the namespace `Tumpel.HostControl` (`ControlMessage` names the control plane's data messages and keeps that name):

| Message                  | From          | Carries                                                               |
| ------------------------ | ------------- | --------------------------------------------------------------------- |
| Challenge                | Control plane | A nonce                                                               |
| Hello                    | Host          | Host id, signature, supervisor version, data and guest ranges         |
| Welcome                  | Control plane | Data range, release channel, current release version for that channel |
| Heartbeat                | Both          | `sentAt`                                                              |
| ReleasePublished         | Control plane | Release version and channel                                           |
| UpdateStep, UpdateFailed | Host          | Step or reason as a PascalCase string, sha256s, detail                |

Revoked (4403), Replaced (4409) and Lapsed (4410) close it. Everything else lives on the data channel: TurnOffer, TurnClaim, turn lines, snapshots, layers, Claude setup boxes and HostHeartbeat with usage. ReleasePublished names only a version. The host reads the manifest from `GET /v1/releases/current`, as EDD-008 does, so the manifest's shape never enters the control protocol.

## Keeping the control protocol stable

`ControlProtocol.Version` is 1 and is expected to stay 1. Every control message travels outside frames and is never resent. The host sends its latest update step again after each control Welcome. A receiver ignores unknown fields and drops an unknown message type with a log line. Step and failure reasons are strings, so a new reason never fails an older decoder. `control-wire.json` locks the shape, and its own guard fails `npm run generate` on any change. Only an added field passes, and only with the lock rewritten in the same commit. The types are one small generated module with no per-version copies. The control Hello signs `tumpel-control-hello-v1`.

## Negotiation on the data channel

`ChannelProtocol` carries `Oldest`. The data Hello carries `protocolVersion`, the host's newest, and `oldestProtocolVersion`. The control plane picks the newest version inside both ranges and names it in the data Welcome. With no overlap it closes 4426 and names both ranges. Challenge, Hello, Welcome and the close codes keep that shape in later versions, so any control plane decodes any future data Hello.

The control Welcome tells the supervisor the control plane's data range before it dials data. A supervisor outside the range skips the data dial and updates.

Speaking to an older peer costs the newer side: a supervisor speaks every version in its window, so it carries their codecs.

## Breaking and additive changes

A new optional field on the current version needs no new version: the current version's lock is the living one, and the wire guard accepts the field there. A removal, a retype, a required field and a new message each take a new version, and every lock below the current version stays frozen. The window makes a version cheap. Both decoders ignore unknown fields: zod drops them, and the generated Rust types carry no `deny_unknown_fields`.

| Change                                     | Older receiver    | Kind     |
| ------------------------------------------ | ----------------- | -------- |
| Required field added                       | Ignores it        | Additive |
| Message added that the receiver can refuse | Refuses the frame | Additive |
| Message added that needs an answer         | Never answers     | Breaking |
| Enum member or union variant added         | Fails to decode   | Breaking |
| Field, message, member or variant gone     | Fails to decode   | Breaking |
| Field type changed                         | Fails to decode   | Breaking |

An additive change lets one encoder serve both versions. A breaking change needs an adapter on each side between the newest types and the older version's, deleted with that version. Like the control plane, the supervisor answers an unknown data message with a refusal and keeps the socket open. A field that must be required arrives with a new version: it is required in the new version's types and absent from the older version's; an optional field joins the current version in place.

TurnClaim carries no `cloneSeconds`, because the host learns it only once the image is in hand. So the control plane does not fail a turn ImageFetchTimedOut or NoFirstOutput itself, and the host enforces both. A planned additive change brings back the control plane's backup timers for the clone: a new data version adds a host message, TurnBoxReady, with `cloneSeconds`, sent once the image is in hand. A control plane on that version arms its backup timers from it. A host on an older version never sends it, and its turns keep the host's budgets alone. A control plane on an older version refuses the frame, and the turn goes on.

## Codegen and the wire lock

The data lock is one file per supported version, `typespec/channel-wire/v<N>.json`, and the guard covers the guest messages in `supervisor.tsp` as `guest-wire/v<N>.json`. A lock older than the newest is frozen. Raising `Oldest` deletes the files below it. The older versions' types come from frozen copies of the generated output or from `@versioned` with `@added` and `@removed` (decision 2). The `@versioned` path through the zod emitter and `crates/xtask` is not tested. Either way, three versions in the window means three copies of the data types.

## The guest link

The guest gets no control channel. The supervisor is its control plane: it picks the guest drive, boots the box and fails it. A layered boot carries the guest drive of the supervisor's own build, so it always matches. A full image carries its own guest, so `GuestProtocol` carries `Oldest` next to `Version`, as the data channel does. The supervisor accepts a guest whose GuestHello `protocolVersion` lies from `Oldest` to `Version` and fails any other box BoxBootFailed, naming both; `release-publish` accepts an image release whose `guestProtocolVersion` lies in that window. The window holds only versions the supervisor speaks, so `Oldest` drops below `Version` only in a bump whose supervisor still speaks the older guest, and a bump that keeps the older guest needs no `images-v*` tag before the supervisor publishes.

## Lapsed hosts

The heartbeat deadline alarm of the host's Durable Object reads the host Offline and sets the same alarm again for `offlineGraceSeconds`. A control Welcome before it fires clears it. When it fires on an Offline host, the host turns Lapsed, in the tenant and in the central `hosts` row. The grace sits in the control plane's schema-checked settings object, one value for the stage. A Lapsed host's control Hello closes 4410 with the reason "this host was offline for more than 3 days; a tenant owner must re-admit it before it rejoins". Decision 3 names what re-admits it.

## Release versions

A tag `vX.Y.Z` runs `release.yml`, which publishes that version. An automatic release from main (decision 9) is `X.Y.(Z+1)-main.N+<sha12>`, where `vX.Y.Z` is the latest tag and N counts the commits since it. Semver orders it after `vX.Y.Z` and before `vX.Y.(Z+1)`. `crates/release_version.rs` and `release-publish` build it from `git describe`, so the binaries job checks out with `fetch-depth: 0`. `tumpel release current`, `tumpel --version`, the control Hello's supervisor version, the central `hosts` row and the dashboard host page show it. The updater still decides by sha256.

Workers Builds deploys the control plane from one branch only. Its production branch is `release`, and builds of every other branch are off, so a push to main deploys nothing. `release.yml` on the self-hosted runner fast-forwards `release` to the release commit as its last step. Workers Builds triggers on branches, which is why a branch carries the deploy and the tag does not. The runner holds no Cloudflare token. It needs `contents: write` and a ruleset that lets only that workflow move `release`.

## Fleet rollout

The central store holds every host and its presence, because routing needs them before the tenant is known (AGENTS.md). Its `hosts` row carries the data range and `releaseChannel`, written by the control Hello next to `supervisor_version`. The counts are a `GROUP BY` over that table, indexed on version and state. Thousands of rows need no roll-up table, and each write follows a Hello or a presence change. Lapsed and Revoked hosts drop out of the count.

Release channels stage a rollout. A host label sets `releaseChannel`, Canary or Stable, and the control Welcome passes it on. `release.yml` writes a prerelease to `canary.json` and a tagged release to `current.json`. A Canary host reads `GET /v1/releases/current?channel=Canary`, an optional query parameter and so pre-approved. The proof hosts run Canary, so `npm run proof:e2e` proves each prerelease on real hardware first.

The read model `ReleaseRollout` carries both releases, the control plane's data range, the host count per supervisor version, data version, channel and state, and each host that blocks raising `Oldest`. Per tenant, Host carries the protocol fields on `GET /v1/hosts`, an additive change. The stage-wide view has no endpoint to extend: `GET /v1/releases/current` takes no sign-in and `GET /v1/hosts` reads one tenant. So it needs `GET /v1/releases/rollout` and an operator role (decision 7).

## Rollout order

Every release runs one path on the runner:

1. A tag starts `release.yml`. The runner builds and publishes the supervisor and, on an image tag, the images.
2. The protocol gate reads `ReleaseRollout`. It stops when the release raises `Oldest` while a counted host speaks a lower version, and names each host.
3. The runner fast-forwards `release` to the tag.
4. Workers Builds deploys the control plane from `release`.

The supervisor ships before the control plane that needs it, and OR-11 makes that safe: the new supervisor speaks the old control plane's version until the deploy lands. A breaking change to data version N takes two releases. The first ships `Version` N with `Oldest` at N-1. The second raises `Oldest` once the gate shows no counted host below N. A prerelease reaches Canary hosts first and the proof runs on them, and a Stable tag follows.

An old host behind `Oldest` keeps its control channel. Its control Welcome names a data range it misses, so it skips the data dial and reads the release. It fetches, verifies and dry-runs the binary, checking the candidate's range against the control Welcome's, then swaps once no box runs (OR-6). The new binary's trial ends at the data Welcome. The 4426 exit 6 and the 60 s `ExecStopPost` sleep go.

## CI and deploy gates

- `npm run generate` fails on any control wire change, on a change to a frozen data lock, and on a data change with no new version.
- A contract test per supported version: the control plane decodes fixtures of every host message of each version, and `cargo test` decodes the control plane's messages for each.
- The protocol gate in `release.yml` runs between publish and the move of `release`, so a release that fails it publishes binaries no host reads and deploys nothing.
- `npm run deploy` on Workers Builds checks the central `hosts` table through D1 again before deploying a higher `Oldest`, because a host can come back between the gate and the deploy.
- `release-publish` refuses to write the manifest for a supervisor whose data range misses the deployed control plane's, read from `ReleaseRollout`, and refuses images whose guest range misses the supervisor's.

## Open decisions

1. **Connection shape.** (a) Recommended: two WebSockets to one Durable Object, so a data close leaves control up. (b) One socket: cheaper, and a data close cuts both.
2. **Old data types.** (a) Recommended: freeze a copy of the generated types at each bump. (b) `@versioned` with `@added` and `@removed`, untested on the Rust and zod path.
3. **Re-admitting a Lapsed host.** (a) Recommended: a tenant owner runs `tumpel host readmit` or the dashboard button, a small new hosts operation. (b) Enrol it again. (c) Admit it on control only to self-update.
4. **Lapsed refusal.** (a) Recommended: the control Hello closes 4410. (b) Control accepts it and the data Hello is refused.
5. **Canary ring.** (a) Recommended: the control Welcome names the host's channel from a host label. (b) The host reads it from its runtime config.
6. **Support window.** (a) Recommended: N-1, with room for a third version when a rollout stalls. (b) N-2. (c) Three always.
7. **Stage-wide view.** (a) Recommended: `GET /v1/releases/rollout` for a new operator role, read by the gate with an operator token. (b) The gate reads D1 through a read-only Cloudflare token on the runner, and no stage-wide view exists.
8. **Tag scheme.** (a) Recommended: `vX.Y.Z` for supervisor, CLI and control plane, with `images-vX.Y.Z` apart. (b) One tag builds the images too.
9. **Automatic releases from main.** (a) Recommended: each push cuts a prerelease on the same gated path: Canary hosts and the dev control plane. (b) Only tags release. (c) The prerelease supervisor reaches Canary, and the control plane waits for a tag.
10. **Guest link.** (a) Recommended: the supervisor stays the guest's control plane. (b) A fixed control message set on vsock.

## FAQ

**Why not keep exact match and deploy the Worker after the release?** That order holds only while one runner, the cancelled runs and the deploy line up.

**Does every data change still need a bump?** Yes. The bump is cheap because the control plane keeps the version before it.

**What does an old host see after a drop?** A control Welcome naming the current data range, then a self-update. Its boxes keep running.

**What if the control protocol needs a breaking change?** It takes a new path and signing label, and the control plane serves both paths for good.
