# EDD-009: Protocol compatibility

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md). It adds OR-8 to OR-17 and changes the handshake of [EDD-002](002-host-channel.md) and the release order of [EDD-008](008-supervisor-self-update.md).

## Summary

Each host keeps two connections to the control plane. The small, frozen control channel names the host, the versions each side speaks, and when to update. The data channel carries turns, transcripts and snapshots, and its shape changes with most releases. There, each side names its oldest and newest version, and the pair speaks the newest both know. The control plane keeps one to three data versions side by side. A release drops the oldest only when no counted host speaks it. A host offline past a global grace of 3 days becomes Lapsed and stops counting. Only a release deploys the control plane, after its supervisor publishes and passes the gate.

Matthijs ruled on 2026-11-16; his words are in the appendix, and each requirement names the ruling it traces to. He called that day's lockout "at least the second or third time", so this EDD treats it as systemic.

## The lockout of 2026-11-16

ChannelProtocol went from 14 to 18 in four commits between 10:14 and 12:09 UTC. Workers Builds deployed the control plane 3 to 6 minutes after each push. `release.yml` published the supervisor 12 to 14 minutes after it on one self-hosted runner, and newer pushes cancelled older runs, so no protocol 17 supervisor existed until 11:46. The control plane accepts one exact version and closes any other Hello with 4426. On 4426 with boxes running, the supervisor asked for an immediate update, got Ready from a staged release of the old protocol, and exited 6, killing both boxes. The restart swapped in the staged binary, which met 4426 in its trial and rolled back, every 66 s. The fleet was offline 11:32 to 11:47 and 12:16 to 12:21, and four turns failed HostOffline. Nothing compared the deployed Worker, the published release and the fleet.

## Requirements

- **OR-8 Control channel.** Each host keeps a control channel apart from its data channel, and the control plane accepts every control protocol version it ever shipped. (ruling 9)
- **OR-9 Side by side.** The control plane accepts every data version from `ChannelProtocol.Oldest` to `ChannelProtocol.Version`, one to three versions. (ruling 2)
- **OR-10 Negotiation.** Each data Hello and GuestHello names the sender's oldest and newest version. The answer names the newest version both sides know. (ruling 1)
- **OR-11 Newer peers.** A supervisor newer than the control plane, or a guest newer than its supervisor, speaks the older peer's version when its range holds it. (ruling 4)
- **OR-12 Drop gate.** A release that raises `ChannelProtocol.Oldest` stops before it deploys while any counted host speaks a lower version. (rulings 3, 6)
- **OR-13 Lapsed.** A host Offline for `offlineGraceSeconds`, one value per stage and 259,200 by default, becomes Lapsed. It stops counting and rejoins only after an intervention. (rulings 7, 8)
- **OR-14 A refusal keeps the boxes.** A supervisor whose data range misses the control plane's never exits while a box runs, and updates over control. (OR-6, ruling 9)
- **OR-15 Real versions.** Every release carries a semantic version. A tag `vX.Y.Z` cuts a stable release, and an automatic release from main carries a prerelease version. (ruling 5)
- **OR-16 Fleet view.** MCP, the CLI and the dashboard read one model of the releases, host counts per version and state, and what blocks raising `Oldest`. (ruling 6)
- **OR-17 Deploy on release.** Workers Builds deploys only from the branch `release`, which the runner moves after publish and the gate. (ruling 10)

## Control and data channels

The supervisor opens two WebSockets to the host's Durable Object: `/v1/hosts/{hostId}/control` and the existing `/v1/hosts/{hostId}/channel`, now the data channel. The control channel opens first. A data protocol error, a frame gap or a 4426 closes only the data socket, so the control plane can still reach the host. The cost is a second signed handshake and a second hibernating socket per host. One socket carrying both, as Heartbeat and ReleasePublished travel outside frames today, saves that but lets a data close cut control too (decision 1).

The control channel carries a fixed set, in the namespace `Tumpel.HostControl` (today's `ControlMessage` names the control plane's data messages, and keeps that name):

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

`ControlProtocol.Version` is 1 and is expected to stay 1. Every control message travels outside frames and is never resent. The host sends its latest update step again after each control Welcome. A receiver ignores unknown fields and drops an unknown message type with a log line. Step and failure reasons are strings, so a new reason never fails an older decoder. `a6da93b` had to keep removed update enum members for that reason. `control-wire.json` locks the shape, and its own guard fails `npm run generate` on any change. Only an added field passes, and only with the lock rewritten in the same commit. The types are one small generated module with no per-version copies. The control Hello signs `tumpel-control-hello-v1`.

## Negotiation on the data channel

`ChannelProtocol` gains `Oldest`. The data Hello keeps `protocolVersion`, now the host's newest, and gains `oldestProtocolVersion`. The control plane picks the newest version inside both ranges and names it in the data Welcome. With no overlap it closes 4426 and names both ranges. Challenge, Hello, Welcome and the close codes keep that shape in later versions, so any control plane decodes any future data Hello.

The control Welcome tells the supervisor the control plane's data range before it dials data. That is the dynamic half of ruling 1. A supervisor outside the range skips the data dial and updates.

Speaking to an older peer costs the newer side: a supervisor speaks every version in its window, so it carries their codecs. The control plane of protocol 18, which matches exactly, reads the new Hello, since zod drops unknown fields. A supervisor of range 18 to 19 that gets 4426 from it dials once more and names 18 as its newest. The supervisors that predate the split speak data version 18 and keep working while 18 sits in the window.

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

An additive change lets one encoder serve both versions. A breaking change needs an adapter on each side between the newest types and the older version's, deleted with that version. The supervisor gains the refusal the control plane already has, and answers an unknown data message with a refusal and keeps the socket open. A field that must be required arrives with a new version: it is required in the version 19 types and absent from the version 18 types; an optional field joins the current version in place.

The first planned additive change brings back the control plane's backup timers for the clone. `cdf8a28` took `cloneSeconds` off TurnClaim, because the host learns it only once the image is in hand. Since then the control plane no longer fails a turn ImageFetchTimedOut or NoFirstOutput itself, and the host enforces both. Data version 19 adds a host message, TurnBoxReady, with `cloneSeconds`, sent once the image is in hand. A control plane on 19 arms its backup timers from it. A host on 18 never sends it, and its turns keep the host's budgets alone. A control plane on 18 refuses the frame, and the turn goes on. No host is locked out, and nothing changes until both sides reach 19.

## Codegen and the wire lock

The data lock becomes one file per supported version, `packages/api/channel-wire/v<N>.json`, and the guard covers the guest messages in `supervisor.tsp` as `guest-wire/v<N>.json`. A lock older than the newest is frozen. Raising `Oldest` deletes the files below it. The older versions' types come from frozen copies of the generated output or from `@versioned` with `@added` and `@removed` (decision 2). The `@versioned` path through the zod emitter and `crates/xtask` is not tested. Either way, three versions in the window means three copies of the data types.

## The guest link

The guest gets no control channel. The supervisor is its control plane: it picks the guest drive, boots the box and fails it. `GuestProtocol` gains `Oldest`, GuestHello names the guest's range, and a new GuestWelcome names the version the box speaks. A layered boot carries the guest drive of the supervisor's own build, so it always matches. A full image carries its own guest, which is why a GuestProtocol bump needs an `images-v*` tag in the same window as the supervisor today (images-v0.1.13 is current; one pending commit bumps the guest to 10). `release-publish` checks that the images' guest range meets the supervisor's, in place of the equality at line 469.

## Lapsed hosts

The heartbeat deadline alarm of the host's Durable Object reads the host Offline, as now, and sets the same alarm again for `offlineGraceSeconds`. A control Welcome before it fires clears it. When it fires on an Offline host, the host turns Lapsed, in the tenant and in the central `hosts` row. The grace sits in the control plane's schema-checked settings object, one value for the stage. A Lapsed host's control Hello closes 4410 with the reason "this host was offline for more than 3 days; a tenant owner must re-admit it before it rejoins". Decision 3 names what re-admits it.

## Release versions

A tag `vX.Y.Z` runs `release.yml`, which publishes that version, as today. An automatic release from main (decision 9) is `X.Y.(Z+1)-main.N+<sha12>`, where `vX.Y.Z` is the latest tag and N counts the commits since it. Semver orders it after `vX.Y.Z` and before `vX.Y.(Z+1)`. `crates/release_version.rs` and `release-publish` build it from `git describe` in place of `0.0.0-<sha12>`, so the binaries job checks out with `fetch-depth: 0`. `tumpel release current`, `tumpel --version`, the control Hello's supervisor version, the central `hosts` row and the dashboard host page show it. The updater still decides by sha256.

Workers Builds keeps deploying the control plane, from one branch only. Its production branch becomes `release`, and builds of every other branch are off, so a push to main deploys nothing. `release.yml` on the self-hosted runner fast-forwards `release` to the release commit as its last step. Workers Builds triggers on branches, which is why a branch carries the deploy and the tag does not. The runner holds no Cloudflare token. It needs `contents: write` and a ruleset that lets only that workflow move `release`. Both are CI changes that need explicit approval.

## Fleet rollout

The central store already holds every host and its presence, because routing needs them before the tenant is known (AGENTS.md). Its `hosts` row gains the data range and `releaseChannel`, written by the control Hello next to `supervisor_version`. The counts are a `GROUP BY` over that table, indexed on version and state. Thousands of rows need no roll-up table, and each write follows a Hello or a presence change. Lapsed and Revoked hosts drop out of the count.

Release channels stage a rollout. A host label sets `releaseChannel`, Canary or Stable, and the control Welcome passes it on. `release.yml` writes a prerelease to `canary.json` and a tagged release to `current.json`. A Canary host reads `GET /v1/releases/current?channel=Canary`, an optional query parameter and so pre-approved. The proof hosts run Canary, so `npm run proof:e2e` proves each prerelease on real hardware first.

The read model `ReleaseRollout` carries both releases, the control plane's data range, the host count per supervisor version, data version, channel and state, and each host that blocks raising `Oldest`. Per tenant, Host gains the protocol fields on `GET /v1/hosts`, an additive change. The stage-wide view has no endpoint to extend: `GET /v1/releases/current` takes no sign-in and `GET /v1/hosts` reads one tenant. So it needs `GET /v1/releases/rollout`, which needs explicit approval and an operator role the stage lacks (decision 7).

## Rollout order

Every release runs one path on the runner (ruling 10):

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

**Why not keep exact match and deploy the Worker after the release?** That order holds only while one runner, the cancelled runs and the deploy line up. Four bumps in two hours broke it twice.

**Does every data change still need a bump?** Yes. The bump is cheap because the control plane keeps the version before it.

**What does an old host see after a drop?** A control Welcome naming the current data range, then a self-update. Its boxes keep running.

**What if the control protocol needs a breaking change?** It takes a new path and signing label, and the control plane serves both paths for good.

## Appendix of rulings

On 2026-11-16 Matthijs ruled:

1. > Implement both approaches, not one: multi-protocol support plus a protocol evolution scheme (version negotiation, forward-compatible additive changes).
2. > The control plane must be able to run at least one to three protocol versions side by side.
3. > Gate: a deployment that drops an old protocol must not go out until we've verified every client (host supervisor, guest) has switched over.
4. > Forward changes to the protocol must be supported too.
5. > Release control: releases are cut by tagging, to give control over the release cadence, with semantic versioning (or similar) instead of 0.0.0-<sha>. Automatic releases stay allowed ('release the main is release the main'), but every release carries a real version. This applies to what deploys to the build hosts and the fleet.
6. > keep it simple. The control plane already knows every client [...] so measure it directly: a protocol can be dropped only when no enrolled host still speaks it. But design for fleet scale: imagine hundreds of tenants and thousands of machines.
7. > an offline machine gets a grace period, configurable, defaulting to 3 days. After the grace period an offline client can no longer rejoin the fleet without intervention, so it doesn't hold a protocol open and doesn't count toward 'all clients switched over'.
8. > The offline grace period is global, not per tenant, because the protocol is controlled globally.
9. > Separate the control channel from the data channel. [...] There must also be a separate control-channel protocol, intentionally kept super simple and very stable, used to tell hosts to do things like updating themselves. The point is that even an old host can always be reached and told to update, so it can get onto the current data protocol.
10. > keep Workers Builds, but stop it deploying from main. Deploys happen on a release only: the self-hosted GitHub runner cuts the (semver) release and, after the release publishes the supervisor and passes the protocol gate, moves what Workers Builds watches. Use a dedicated release branch as Workers Builds' production branch (Workers Builds triggers on branches, not tags), with automatic builds for other branches off. No Cloudflare deploy token on the runner; Cloudflare keeps doing the deploy.
