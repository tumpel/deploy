# RFC: Events, one ordered log of domain events per tenant

| Field   | Value                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | Approved (2026-11-18)                                                                                                                                                       |
| Scope   | Design only; the tenant Durable Object, the public API, MCP, the CLI, the dashboard, webhooks and Web Push                                                                  |
| Related | [RFC: Tumpel](RFC-TUM-Tumpel.md), [RFC: Tenant API](RFC-TUM-TenantApi.md), [EDD-002](../EDD/002-host-channel.md), [EDD-005](../EDD/005-mcp-and-cli.md), mvhenten/tumpel#277 |

## Summary

An event is a record that something happened in a tenant: a turn completed, a session went idle, a host went offline. Today no client learns of a change until it reads again. This RFC gives each tenant one durable, ordered event log in the tenant Durable Object. The control plane appends an event in the same transaction that changes the state it reports. Each event has an increasing `eventId`, so a client resumes from the last id it saw and misses nothing.

One operation, `Events_list`, reads the log. It answers JSON to a long poll and Server-Sent Events to a stream, and its MCP tool `tumpel_events_wait` blocks for up to 50 s. Webhooks and Web Push carry events to clients that hold no connection.

The client docs set the limits. No Claude app, Codex or Pi honours a pushed MCP resource update from a remote server today. MCP clients therefore get events when the model calls `tumpel_events_wait`, Claude Code gets them through a plugin monitor, and a phone gets them through Web Push from the dashboard.

## Problem statement

1. `tumpel_turn_wait` wakes on turn end only, for at most 50 s. The tenant Durable Object keeps its waiters in an in-memory set, `turnEndWaiters`, so an instance restart drops every waiter.
2. Only `endTurn` wakes a waiter. The tenant Durable Object also changes session state through `setSessionState` at seven call sites and through direct updates. The HostChannel Durable Object changes host presence, and the tenant Durable Object changes prebuild state. None of these changes signals a client.
3. The dashboard reads a transcript every 100 ms to 5 s, and the CLI's `--follow` backs off from 250 ms to 5 s. Both learn that a turn ended by reading it again.
4. `rules/architecture.md` 4 requires event-driven lifecycle with no polling.

## Requirements

1. R1: Domain events such as TurnDone, TurnFailed, SessionIdle, HostOffline and PrebuildDone reach every client: the CLI, the dashboard, and MCP clients including the Claude desktop and phone apps. Source: owner's brief, 2026-11-18.
2. R2: One durable, ordered log per tenant, with a cursor and replay. Source: owner's brief.
3. R3: TypeSpec in tumpel/protocol defines every event. Source: `rules/typespec.md` 1.
4. R4: Every new tenant Durable Object call goes through the Tenant API. Source: [RFC: Tenant API](RFC-TUM-TenantApi.md) D1.
5. R5: The RFC states what each client can receive per its own docs, and says where the docs are silent. Source: owner's brief.
6. R6: An event never starts work. Source: tenet 3.

## What Tumpel emits today

| Source                    | State change                                                             | Who learns of it                               |
| ------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| Tenant Durable Object     | Turn `Offered`, `Running`, `Completed`, `Failed` (`endTurn`, `failTurn`) | `waitTurns` callers in the same instance       |
| Tenant Durable Object     | Session `Starting` to `Archived` (`setSessionState` and direct updates)  | Nobody                                         |
| HostChannel and tenant DO | Host `Online`, `Offline` (`presence`, then `hostPresence`)               | The tenant DO, to start its heartbeat deadline |
| Tenant Durable Object     | Prebuild `Dispatched` to `Done` or `Failed`                              | Nobody                                         |
| tumpel/cli                | `turn wait`, `session transcript --follow`                               | The user, after a long poll or a backoff loop  |
| tumpel/dashboard          | Transcript and Claude setup reads on a timer                             | The user, after the next read                  |

## Event catalogue

Decision D1: tumpel/protocol defines one model per event and a discriminated union, `TenantEvent`, keyed by `event`. Every event carries `eventId`, `tenantId` and `createdAt`. A payload holds ids and the fact that changed. A client reads the resource for the rest. The names follow the existing enums, so the brief's TurnDone is `TurnCompleted`, after `TurnState.Completed`.

| Event             | Appended when                     | Payload beyond the envelope               |
| ----------------- | --------------------------------- | ----------------------------------------- |
| `TurnStarted`     | A host claims a turn              | `turnId`, `sessionId`                     |
| `TurnCompleted`   | A turn ends `Completed`           | `turnId`, `sessionId`                     |
| `TurnFailed`      | A turn ends `Failed`              | `turnId`, `sessionId`, `reason`, `detail` |
| `SessionIdle`     | A session enters `Idle`           | `sessionId`, `turnId` of the last turn    |
| `SessionStopped`  | A session enters `Stopped`        | `sessionId`                               |
| `SessionFailed`   | A session enters `Failed`         | `sessionId`                               |
| `SessionArchived` | A session enters `Archived`       | `sessionId`                               |
| `HostOnline`      | A host's channel opens            | `hostId`                                  |
| `HostOffline`     | A host's last open channel closes | `hostId`                                  |
| `PrebuildDone`    | A prebuild enters `Done`          | `prebuildId`, `repository`                |
| `PrebuildFailed`  | A prebuild enters `Failed`        | `prebuildId`, `repository`, `phase`       |

Each payload is complete for its event, so no event has an optional field (`rules/typespec.md` 6). A new event type is an additive change. A changed payload is a new event type.

Tumpel derives every event from control-plane state. It never reads a transcript to make one (tenet 2).

## The log

Decision D2: a tenant SQLite migration adds `events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, payload TEXT, created_at INTEGER)`. SQLite assigns ids in commit order inside the single-threaded Durable Object, so the id is the total order of the tenant's events.

The code that changes a state appends its event in the same `transactionSync`. A turn's `endTurn` record, `setSessionState`, `hostPresence` and each prebuild transition gain one insert. The state row and its event commit together, or neither commits.

The log keeps 7 days. Each insert deletes rows older than that in the same transaction, through an index on `created_at`. A read with an `afterEventId` older than the oldest row fails 410 `EventCursorExpired`. Its fix tells the client to read current state and continue from the `lastEventId` that read returns.

After each commit, the Durable Object wakes every waiter, as `turnEnded` does today. `waitTurns` moves onto that wake and keeps its contract.

## Reading the log

Decision D3: one public operation reads the log, `Events_list` at `GET /v1/events`. It takes `afterEventId`, a repeatable `event` filter, an optional `sessionId` filter and `waitSeconds` from 0 to 50. It returns `EventPage { events, lastEventId }` with at most 100 events. With no `afterEventId`, it starts at the current end of the log. When no event matches, it waits up to `waitSeconds` for one.

The same handler answers `Accept: text/event-stream` with a stream. Each event is one SSE message whose `id` is its `eventId`. A browser `EventSource` resends `Last-Event-ID` on reconnect, and the handler resumes after it ([HTML Living Standard](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header)). Cloudflare sets no duration limit on an HTTP Worker while the client stays connected ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#duration)).

| Surface | Name                   | Use                                                |
| ------- | ---------------------- | -------------------------------------------------- |
| REST    | `GET /v1/events`       | Long poll, or SSE with `Accept: text/event-stream` |
| MCP     | `tumpel_events_wait`   | Long poll, 50 s at most                            |
| CLI     | `tumpel events wait`   | One page as JSON                                   |
| CLI     | `tumpel events follow` | The stream, one JSON line per event                |

The 50 s cap fits every client's tool timeout: 240 s on claude.ai and Claude Desktop ([Claude connector docs](https://claude.com/docs/connectors/building)) and 60 s by default in Codex ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)). Every member reads every event of the tenant, the same rows `Sessions_list` and `Hosts_list` return.

## Tenant API

Decision D4: the Tenant API gains two operations, `ListEvents` and `WaitEvents`, an additive change ([RFC: Tenant API](RFC-TUM-TenantApi.md) D3). Both take and return plain JSON. `WaitEvents` blocks for at most its `waitSeconds`, as `waitTurns` does.

The Worker builds the SSE stream. It calls `WaitEvents` in a loop and writes each page as frames, so no stream crosses the Durable Object boundary. When a deploy answers `TenantApiVersionUnsupported` or `TenantOperationUnknown`, the Worker sends an SSE `retry` of 5 s and closes the stream. The client reconnects with `Last-Event-ID` and loses no event.

## What each client can receive

Decision D5: Tumpel delivers through the paths each client documents. Revision 2026-07-28 of MCP replaced the GET stream and `resources/subscribe` with `subscriptions/listen` ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). A listen stream carries list changes and `notifications/resources/updated` for chosen URIs ([subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md)). Progress notifications flow only on the stream of the request they belong to. Multi round-trip requests replaced server-initiated elicitation, so elicitation carries no event.

| Client                         | What its docs say it receives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Tumpel path                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Claude web, Desktop and mobile | Connectors connect from Anthropic's cloud to a remote server. The docs list "Resource subscriptions" and "Advanced or draft capabilities" as unsupported ([connector docs](https://claude.com/docs/connectors/building)). They are silent on list changes and `subscriptions/listen`. No doc lets a remote server start a turn in a conversation. The community matrix marks Tasks for Claude web ([extension matrix](https://modelcontextprotocol.io/extensions/client-matrix.md)), which the connector docs contradict                                                                                                                                                                                                    | `tumpel_events_wait` when the model calls it. Web Push for the phone  |
| Claude Code                    | It refreshes on `list_changed` and holds a listen stream for it on the v2 runtime ([MCP docs](https://code.claude.com/docs/en/mcp#dynamic-tool-updates)). Its docs are silent on `notifications/resources/updated`. Channels push into a session, but only from a local stdio server on an allowlist, in research preview, and never from a server on 2026-07-28 ([channels reference](https://code.claude.com/docs/en/channels-reference)). A plugin monitor runs for the whole session and feeds each output line to Claude ([plugin monitors](https://code.claude.com/docs/en/plugins/components#monitors)). An `asyncRewake` hook wakes an idle session on exit code 2 ([hooks](https://code.claude.com/docs/en/hooks)) | A plugin monitor running `tumpel events follow`. `tumpel_events_wait` |
| Codex                          | The docs list stdio and Streamable HTTP and are silent on notifications ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)). Source at commit `0e011c0` refreshes on `tools/list_changed` behind a flag and opens event streams only to its own apps server ([connection manager](https://github.com/openai/codex/blob/0e011c00928a16579b0bda47473cee986628cb51/codex-rs/codex-mcp/src/connection_manager.rs))                                                                                                                                                                                                                                                                                        | `tumpel_events_wait`                                                  |
| Pi 1.5.2                       | Source handles `tools/list_changed`, `notifications/message` and progress, and no resource update ([MCP runtime](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/extensions/mcp/runtime.ts))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tumpel_events_wait`                                                  |
| Agent SDK app                  | Streaming input sends further messages into a running session ([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The app follows the SSE stream and yields a message per event         |
| tumpel CLI and TUI             | Tumpel's own client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The SSE stream                                                        |
| Dashboard                      | A browser `EventSource` while open. Web Push when closed, on iOS 16.4 and later only from a Home Screen web app ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | SSE, then Web Push                                                    |

## Claude Code

Decision D6: the tumpel CLI ships a Claude Code plugin with one monitor, `tumpel events follow --event TurnCompleted --event TurnFailed --event SessionIdle --event HostOffline --event PrebuildDone --event PrebuildFailed`. Each event reaches Claude as one line, and Claude reads the resource it names with the existing tools. Plugin monitors start only in interactive sessions. The Claude Code docs do not state whether a monitor line wakes an idle session.

A channel would need a local stdio server, a place on Anthropic's allowlist and an MCP revision older than 2026-07-28, which Tumpel's endpoint already speaks. Tumpel builds no channel.

## Webhooks

Decision D7: an Owner registers a webhook endpoint with a URL and a list of event types. Operations `WebhookEndpoints_create`, `_list`, `_get` and `_delete` follow `rules/api.md` 5. A new `WebhookSender` Durable Object, one per endpoint, keeps the endpoint's cursor and an alarm. After each append, the tenant Durable Object pokes the senders whose filter matches. A sender reads `ListEvents` after its cursor and POSTs each event as JSON, in order. It moves its cursor on a 2xx answer.

On a failure, the sender's alarm retries after 1 minute, doubling to 1 hour. After 3 days of failure, the endpoint reads `Failing` with the last status, and the sender stops until an Owner recreates the endpoint. Delivery is at least once. A receiver drops a repeated `eventId`.

The control plane signs each request with an Ed25519 key per tenant, which the key-store port derives. `GET /v1/webhook-signing-key` returns the public key. No signing secret exists, so none travels over MCP (`rules/api.md` 6).

A tenant points a webhook at a relay of its choice, for example an ntfy topic ([ntfy publish](https://docs.ntfy.sh/publish/)).

## Web Push

Decision D8: the dashboard becomes an installable web app with a manifest and a service worker. A member opts in per device. The browser's push subscription goes to `PushSubscriptions_create` with the event types to notify. A `WebhookSender` with a push variant delivers it. It encrypts the payload per RFC 8291 ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)) and signs a VAPID token per RFC 8292 ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)). The VAPID key pair is a tofu resource (`rules/architecture.md` 9). A 404 or 410 from the push service deletes the subscription.

The notification names the session and the outcome, for example "Turn completed in fix-login". A tap opens the session in the dashboard. On iOS, the member adds the dashboard to the Home Screen first. This is the phone path for every Claude user, because no Claude mobile app receives a pushed MCP event.

## MCP subscriptions

Decision D9: Tumpel exposes `tumpel://events` as an MCP resource and serves `subscriptions/listen` for it only once one target client documents support for resource updates. Until then the work buys no delivery. When it lands, the Worker holds the listen stream, calls `WaitEvents` in a loop and sends `notifications/resources/updated` per page. The client then reads the resource with its cursor.

## Delivery

Decision D10: each slice is one PR. Protocol slices land and release first, and the tumpel PR bumps the three tarball URLs (`rules/typespec.md` 2).

| Slice | Repository       | Change                                                                                                                                                      |
| ----- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | tumpel/protocol  | Event models, `TenantEvent`, `EventPage`, `Events_list`, Tenant API `ListEvents` and `WaitEvents`                                                           |
| E1    | tumpel           | The `events` table, appends in every transition, the Tenant API operations, `GET /v1/events` with SSE, `tumpel_events_wait`, `waitTurns` on the shared wake |
| C1    | tumpel/cli       | `tumpel events wait` and `follow`, and the Claude Code plugin with its monitor                                                                              |
| D1    | tumpel/dashboard | One `EventSource` per tenant that invalidates the matching queries                                                                                          |
| P2    | tumpel/protocol  | Webhook endpoint and push subscription models and operations                                                                                                |
| E2    | tumpel           | `WebhookSender`, signing key, webhook operations                                                                                                            |
| E3    | tumpel           | Push delivery and the VAPID tofu resource                                                                                                                   |
| D2    | tumpel/dashboard | Manifest, service worker, per-device opt-in                                                                                                                 |
| E4    | tumpel           | MCP resource and `subscriptions/listen`, once a client supports it (D9)                                                                                     |

Tests stay low in the stack. One unit test per transition checks that the state row and its event commit together. One test drives `Events_list` past an expired cursor. The proof in EDD-006 gains a step that follows the stream across one turn.

Out of scope: events from transcript content, per-member event visibility, MCP Tasks, an event that starts a turn, and a Tumpel-hosted relay for chat apps.

## FAQ

### Why one operation for long poll and stream?

`rules/api.md` 2 forbids a second operation for the same read. SSE is a representation of the same page, picked by `Accept` (D3).

### Can a Claude phone conversation get pushed a turn result?

No. No Claude doc lets a remote MCP server push into a conversation. The phone gets a Web Push notification from the dashboard (D5, D8).

### Why not MCP resource subscriptions now?

Claude's connector docs list them as unsupported, and Codex and Pi source handle no resource update. D9 builds them when a client does.

### What happens to events during a deploy?

They stay in the log. A stream closes with a 5 s retry, and the client resumes from its last `eventId` (D4).

### Does an event ever start a turn?

No. Events report state. Tenet 3 leaves every start to a person or an external trigger (R6).

### How long can a client stay away?

7 days. An older cursor fails `EventCursorExpired`, and the client reads current state again (D2).
