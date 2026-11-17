# EDD-010: Metrics and signal

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md). It adds metrics tables per tenant, a query operation and dashboard charts. Its changes to the data channel of [EDD-009](009-protocol-compatibility.md) are additive.

## Summary

Tumpel times every phase of every turn, sizes every snapshot and clone, and counts every failure by its named reason. Each heartbeat carries the host's CPU, memory, load and box slots. The control plane writes these numbers into metrics tables in the tenant's own database. One API operation reads them as time series: pick a metric, a time range, a bucket size and a breakdown, then click a point to list the turns behind it. The dashboard draws the series as charts you can zoom and drill into, from all hosts down to one turn.

## Requirements

- **M-1 Turn phases.** Each turn that ends leaves one metric row with its outcome and the duration of each phase it reached. (ruling 1)
- **M-2 Breakdowns.** Every turn metric breaks down by host, harness, harness version, model, persona and start kind. (ruling 2)
- **M-3 Host series.** Each heartbeat adds CPU busy, load, memory and box counts to the host's rows for its minute, hour and day. (ruling 3)
- **M-4 Edges only.** The host measures with spans around its existing lifecycle. The control plane measures in one recorder. (ruling 6)
- **M-5 One store per tenant.** Metric rows live in the tenant's database, in tables only the recorder writes. (ruling 7)
- **M-6 Drill-down.** Every chart point leads to the turns behind it. (rulings 4 and 5)
- **M-7 Bounded reads.** A query over more than 500 buckets or 50,000 turns fails MetricRangeTooLarge. (the tenets)

## What is measured

A turn moves through claim, image fetch, restore, boot, clone, first line and run. The appendix of phases lists each one with its clock, its time limit and its named failure. Startup is the time from the offer to the harness's first line, the number in Matthijs's examples.

Each turn records its start kind. Warm resumes a paused box. Cold boots a fresh box for a session with no snapshot. Restored boots a fresh box from the session's snapshot. A turn that ends before its box is ready records NotStarted.

Sizes go with the phases: the bytes of an image fetch, the bytes a restore downloaded, the clone's size on disk, and the turn's transcript lines and bytes. A snapshot records its duration from request to SnapshotDone, its stored size, its uploaded bytes and the host's time to cut, pack and upload.

A turn's outcome is Completed or its TurnFailureReason, and a snapshot's is Stored or its SnapshotFailureReason. Failure counts read that column.

Every 10 seconds a host reports CPU busy, the 1, 5 and 15 minute load averages, memory available and total, boxes running and warm, and box slots.

## Collection

OpenTelemetry was the first candidate. Workers export traces and logs over OTLP. Cloudflare documents that custom metrics cannot be exported that way. Workers tracing is in early beta and keeps seven days. A host holds no standing credential (NFR-2), so it has nothing to push OTLP to a collector with. The design keeps OpenTelemetry's metric names and drops its export path (decision 2).

On the host, the supervisor opens one root span per turn and per snapshot. A child span wraps each phase it already runs: image fetch, restore, boot or resume, persona files, clone, and the snapshot's cut, pack and upload. One `tracing` layer reads each span's duration and fields. When a root span closes, the layer sends one frame: TurnTimings or SnapshotTimings. HostHeartbeat adds five usage fields. The appendix of wire changes lists them.

On the control plane, one recorder module sits where the Tenant Durable Object receives host messages and ends turns. It stamps each phase as its message arrives, on the control plane's clock. Its write of the turn's metric row commits with the turn's end.

The host sends TurnTimings before TurnComplete or TurnFailed, and the channel keeps frame order. A control plane on the older version refuses the new messages with FrameRefused, and the turn goes on. A turn the control plane fails itself, such as NotClaimed or HostOffline, records only the phases it stamped.

## Storage

Matthijs ruled that metrics live per tenant, in the tenant's own store, apart from the operational data (ruling 7). Analytics Engine keeps one dataset per account for three months. Its SQL API takes an account API token, so every tenant's rows sit behind one credential. A collector into a time-series database adds infrastructure outside Cloudflare. It answers percentiles from histogram buckets and cannot carry a turn id as a label. The tenant's SQLite isolates by construction. It answers exact percentiles and finds a point's turns in one query.

That SQLite belongs to the tenant's Tenant Durable Object, which holds `turns` and `host_usage` today. The metrics tables carry the prefix `metric_` (decision 1). The appendix of tables lists them with their retention.

Host rows hold sums, sample counts, minimums and maximums. Each heartbeat upserts all three, so the means stay exact. Retention runs on write. The heartbeat that opens a minute row deletes that host's expired rows. Each turn that ends deletes up to 10 expired turn rows. Both deletes walk an index on time.

## Percentiles

A query reads the matching rows from an index on end time, sorted by bucket, group and value. It picks the 50th, 90th and 99th rank in each bucket. Host percentiles read minute, hour or day rows, so seven days of one host is 10,080 minute rows. The two caps of M-7 keep every read bounded. MetricRangeTooLarge names the count and a range that fits. Sketches written per hour are the alternative (decision 4).

## Query operation

TypeSpec first: `operations.tsp` adds one operation, `Metrics_query`, at `GET /v1/metrics/{metric}`. It takes a time range with offsets, a bucket of Minute, Hour or Day, one breakdown, optional filters and a cursor. The appendix of query parameters lists them. A new operation needs explicit approval (decision 3).

Without a cursor it answers Series. That is one series per breakdown value. Each point carries its bucket start, count, p50, p90, p99, max and a `turnsCursor`. With a cursor it answers Turns: a page of turn rows with session, host, harness, model, outcome and phase durations, and the next cursor. A host point's cursor lists the turns that ran on that host in that bucket, so a spike leads to its work. `GET /v1/turns/{turnId}` adds the turn's phases, an additive field.

MCP gets `tumpel_metrics_query` and the CLI gets `tumpel metrics query`, on the same handler (EDD-005). The CLI prints a table and follows a point's cursor with `--turns`.

## Dashboard

A Metrics screen at `/t/$tenantId/metrics` keeps metric, range, bucket, breakdown and filters in the URL. The Overview shows startup p50 and p90 by harness, and host CPU busy. Clicking a series filters to it. Clicking a point opens the turns table, which links to the existing session and turn pages. The host page gets CPU, load, memory and box charts. The turn page draws one bar per phase.

Ranges come as presets of 1 hour, 24 hours, 7 days, 30 days and 90 days. Dragging across a chart zooms to that range. The screen picks the smallest bucket that stays under 500.

Charts use uPlot: canvas, about 50 KB minified, built for time series, with zoom and auto-rescale (decision 5). Series colours come from eight tokens, `--chart-1` to `--chart-8`, set for both colour schemes in `styles.css`. A canvas ignores CSS, so the chart reads the tokens each time it draws and redraws when `prefers-color-scheme` changes. A breakdown past seven values shows the top seven by count and folds the rest into Other.

## Open decisions

1. **Metrics tables.** (a) Recommended: `metric_` tables in the Tenant object's SQLite, committed with the turn's end. (b) A second Durable Object per tenant, one call away from each turn's end.
2. **Host instrumentation.** (a) Recommended: `tracing` spans and one layer, with OpenTelemetry names and no OpenTelemetry SDK. (b) The `opentelemetry` SDK with an exporter onto the channel, a larger binary for the same numbers.
3. **Query operation.** (a) Recommended: approve `GET /v1/metrics/{metric}`, with series and turn pages behind one cursor. (b) Two operations, one for series and one for turns.
4. **Percentiles.** (a) Recommended: exact on read, capped at 500 buckets and 50,000 turns. (b) Sketches per hour, written with each turn, with no turn cap and answers within a set error.
5. **Chart library.** (a) Recommended: uPlot. (b) Recharts: SVG through React components, a far larger package.
6. **Retention.** (a) Recommended: turns and snapshots 90 days, host minutes 8 days, host hours 90 days, host days 400 days. (b) Everything 90 days.
7. **Rollout.** (a) Recommended: ship the new fields and messages in the data version that adds TurnBoxReady. (b) A data version of their own.

## FAQ

**Can I compare tenants?** A query reads one tenant. Fleet-wide numbers come from Cloudflare.

## Appendix of phases

| Phase       | From and to                                 | Clock         | Limit                                                                                                          | Failure                                       |
| ----------- | ------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Claim       | TurnOffer sent, TurnClaim arrives           | Control plane | `turnClaimBudgetSeconds`, 60 s                                                                                 | NotClaimed                                    |
| Image fetch | TurnImageFetching, image in cache           | Host          | `image.fetchSeconds`                                                                                           | ImageFetchTimedOut                            |
| Restore     | first RestoreChunks, files ready            | Host          | `budgets.bootSeconds` + 1 s per started 32 MiB and per started 2,000 entries; the dispatch credential's expiry | SnapshotUnreadable, DispatchCredentialExpired |
| Boot        | box start or resume, GuestHello             | Host          | `budgets.bootSeconds`, 45 s, + the restore allowance for the restore archive                                   | BoxBootFailed                                 |
| Clone       | box ready, TurnRepositoryReady              | Host          | `cloneSeconds`                                                                                                 | RepositoryCloneFailed                         |
| First line  | TurnRepositoryReady, first TurnLine arrives | Control plane | `turnFirstLineBudgetSeconds`, 120 s                                                                            | NoFirstOutput                                 |
| Run         | first TurnLine, TurnComplete arrives        | Control plane | `turnTotalBudgetSeconds`, 3600 s                                                                               | TurnTimedOut                                  |
| Startup     | TurnOffer sent, first TurnLine arrives      | Control plane | the phases above                                                                                               | the phase's own                               |
| Snapshot    | SnapshotRequest sent, SnapshotDone arrives  | Control plane | `snapshotDeadlineSeconds`, 900 s                                                                               | NotAnswered                                   |

## Appendix of wire changes

All four are additive under EDD-009 and ship in one data version.

| Message         | Change                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------- |
| HostHeartbeat   | `usage` adds `cpuBusy`, `loadAverage5`, `loadAverage15`, `memoryTotalMib` and `boxesRunning` |
| TurnTimings     | New host message: start kind, phase durations, and image, restore and clone bytes            |
| SnapshotTimings | New host message: cut, pack and upload durations and the chunk count                         |
| TurnBoxReady    | Planned in EDD-009 for `cloneSeconds`; its arrival also marks the box ready                  |

## Appendix of tables

| Table                 | One row per                            | Kept                |
| --------------------- | -------------------------------------- | ------------------- |
| `metric_turns`        | ended turn: outcome, dimensions, sizes | 90 days             |
| `metric_turn_phases`  | turn and phase: duration, bytes        | 90 days             |
| `metric_turn_marks`   | phase mark of a turn in flight         | until the turn ends |
| `metric_snapshots`    | ended snapshot                         | 90 days             |
| `metric_host_minutes` | host and minute                        | 8 days              |
| `metric_host_hours`   | host and hour                          | 90 days             |
| `metric_host_days`    | host and day                           | 400 days            |

Every column is required. Outcome holds Completed or the failure reason. Start kind holds NotStarted when no box came up.

## Appendix of query parameters

- `metric`: an enum. Turn metrics are TurnStartup, TurnPhase and TurnOutcome. Others are SnapshotDuration, CloneBytes, HostCpuBusy, HostLoad, HostMemoryAvailable and HostBoxes.
- `from` and `to`: ISO 8601 with an offset.
- `bucket`: Minute, Hour or Day.
- `breakdown`: Host, Harness, HarnessVersion, Model, Persona, StartKind or Outcome.
- `hostId`, `harness`, `model`, `personaId`, `startKind` and `outcome`: optional filters.
- `cursor`: from a point, or from the page before.

## Appendix of rulings

Matthijs ruled on 2026-11-16. The first ruling is his words. The rest are as relayed to the writer.

Ruling 1, in his words:

<!-- vale off -->

> statistics and signal are a core part of Tumpel, and understanding performance matters. Start keeping metrics of everything; every number worth measuring should be measured. Enrich the dashboard with them.

<!-- vale on -->

2. P50 and P90 of startup time for a box, broken down by harness, model, host, and cold start against warm start or snapshot restore.
3. Host performance over time: memory, CPU and load, to see how busy a host runs, when its peak times fall and when it spikes.
4. A dashboard with graphs to dig into: time series with drill-down from fleet to host to harness to session and turn, with ranges you pick and zoom, and filters and breakdowns by host, harness, model, persona or tenant.
5. Clicking a total goes to the sessions and turns behind it.
6. Produce and collect metrics the industry-standard way, which he expected to be OpenTelemetry, and check that first. Harvest metrics at the edges into a dedicated metrics store, outside the application code.
7. Storage: a metrics table per tenant, in each tenant's own store, separate from the operational data. The tenant's own dashboard comes first. Cloudflare already shows fleet-wide metrics.

## Appendix of terms

| Term       | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| Start kind | Warm, Cold, Restored or NotStarted: how the box came up          |
| Startup    | Time from TurnOffer sent to the first TurnLine                   |
| Bucket     | The time one chart point covers: a minute, hour or day           |
| Breakdown  | The dimension that splits a metric into one series a value       |
| Recorder   | The control plane module that alone writes `metric_` tables      |
| CPU busy   | Share of all cores' time spent not idle since the last heartbeat |
