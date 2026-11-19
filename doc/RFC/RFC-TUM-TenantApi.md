# RFC: Tenant API, a versioned contract for the tenant Durable Object

| Field   | Value                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status  | Approved (2026-11-18)                                                                                                                                                                                                    |
| Scope   | Design only; the Worker, the HostChannel and SessionTimer Durable Objects as callers of the tenant Durable Object                                                                                                        |
| Related | [RFC: Tumpel](RFC-TUM-Tumpel.md), [ADR-001](../adr/001-control-plane-on-cloudflare.md), [EDD-002](../EDD/002-host-channel.md), [EDD-009](../EDD/009-protocol-compatibility.md), mvhenten/tumpel#261, mvhenten/tumpel#272 |

## Summary

The tenant Durable Object answers 110 RPC methods. Its callers reach them through `env.TENANT.getByName(tenantId)` stubs and share TypeScript types with it. A deploy switches the Worker to new code at once, and a tenant instance keeps its old code for minutes. In that window a changed shape fails a call, as in #261, or binds an argument to the wrong parameter. Cloudflare offers no deploy orchestration that closes this window (D6).

This RFC replaces the 110 methods with one entry point, `handle`, and one contract, the Tenant API. TypeSpec in tumpel/protocol defines it, next to the public API. Every request names an operation and a Tenant API version, and the Durable Object validates it once at its boundary. A wire lock keeps changes inside a version additive. The Durable Object serves the current and the previous version. It answers a version or operation it does not know with a typed refusal, and then resets itself so the next call runs the deployed code. The caller turns that refusal into a retryable 503. After one protocol PR, eight tumpel PRs move the calls, one group each.

## Problem statement

On the 2026-11-18 16:13 UTC dev deploy, handlers and the tenant Durable Object ran different code for about 6 minutes (#261). `persona get` returned 500, because the old instance returned a persona without `connectorIds` and the handler's zod check threw. Connector list failed with `The RPC receiver does not implement the method listConnectors`. The errors cleared on their own.

Three more shape changes since 2026-11-01 cross the same stub:

1. #258 inserted `updatedAt` as a positional argument into `renameConnector`, `setStaticToken` and `clearConnectorCredential`, and appended it to `deleteConnector`. An old instance ignores the extra `deleteConnector` argument and deletes unconditionally. A new Worker calling an old instance's `renameConnector(tenantId, connectorId, updatedAt, name, now)` hands the number `updatedAt` to the old `name` parameter. The old instance then stores it as the name, and no check fails.
2. #267 renamed `failLostTurns` to `reconcileHeldBoxes`. The HostChannel Durable Object calls it, so a HostChannel instance on new code and a tenant instance on old code fail the same way `listConnectors` did.
3. #253 added a required field to a persona read and a method, the two failures #261 records.

`rules/errors.md` 6 requires validation of external input once, at the boundary. Under skew, a call from another code version is external input, and the tenant Durable Object validates none of it. `rules/errors.md` 3 forbids the fix #261 rules out: a handler that accepts an old shape.

## Requirements

1. R1: A shape change between the Worker and the tenant Durable Object never yields a 500, a missing-method error or a misbound argument during a deploy. Source: #261, #272.
2. R2: The contract is explicit and versioned, with schemas validated at the Durable Object boundary. Source: #272.
3. R3: Within a version, only additive changes land. Source: #272.
4. R4: An older caller is served, or answered with a retryable error. Source: #272.
5. R5: Handlers never accept an old shape. Source: #261, `rules/errors.md` 3.
6. R6: The migration ships in slices of one PR each. Source: #272.

## The current surface

The tenant class is a chain of seven classes, from `TenantSessions` up to `Tenant`. It has 113 public methods. Three are called only from inside the chain (`hasSecretSet`, `heldBoxes`, `buildProviderConnected`). The other 110 cross the stub, from about 140 call sites in 18 files.

| Group                                                | Methods | Callers                                                     |
| ---------------------------------------------------- | ------- | ----------------------------------------------------------- |
| Personas                                             | 5       | Worker handlers                                             |
| Secret sets, pins, config, misc                      | 14      | Worker handlers, HostChannel (`supervisorUpdate`)           |
| Connectors                                           | 11      | Worker handlers                                             |
| OpenRouter, CircleCI and Claude setup authorizations | 16      | Worker handlers, HostChannel, SessionTimer (deadlines)      |
| Prebuilds                                            | 19      | Worker handlers, GitHub and CircleCI webhooks, SessionTimer |
| Build connections and CircleCI projects              | 16      | Worker handlers                                             |
| Sessions and turns                                   | 16      | Worker handlers                                             |
| Host lifecycle                                       | 13      | HostChannel, SessionTimer, deploy drain, hosts handlers     |

Arguments are positional, and most methods take `tenantId` and `now` from the caller. Results are TypeScript unions tagged with `kind`, and a few reuse zod schemas from `@tumpel/schemas` or `persona-files`. Every argument and result is plain JSON: no method passes a stream, a function or a binary buffer. The longest call, `waitTurns`, blocks for at most its `timeoutSeconds`.

Three kinds of caller skew against a tenant instance. A Worker handler switches at deploy. HostChannel and SessionTimer instances restart on their own schedule, like the tenant instance. So a caller can run newer or older code than the instance it calls.

## The contract

Decision D1: the tenant Durable Object exposes one RPC method, `handle(request: TenantRequest): Promise<TenantResponse>`. Every other method becomes protected, so the stub type offers only `handle`, and the type checker rejects a direct call.

A `TenantRequest` carries `tenantApiVersion`, `operation` and `input`. `operation` names one operation, the way a path names a REST operation. `input` is one named object per operation. Positional arguments go, so #258's misbinding cannot recur. `tenantId` and `now` stay explicit input fields, because every caller has both and tests pin `now`.

A `TenantResponse` carries the operation's result, or a refusal. Each result variant is its own model (`rules/typespec.md` 6). A public model, such as `Persona` or `SecretSet`, appears in a result by reference.

The Worker and both Durable Object callers reach the tenant through one client, `tenantApi(env, tenantId)`. It builds the request, calls `handle` and returns the parsed result. The Durable Object parses the request against the operation's input schema, runs the operation and returns its result. A request that fails the schema answers `TenantRequestInvalid` with the zod issues, and the caller fails the operation with a 500 that names the operation.

## Where the contract lives

Decision D2: TypeSpec in tumpel/protocol defines the Tenant API, in the namespace `Tumpel.TenantApi`. The emitter writes its zod schemas into `@tumpel/schemas` and nothing into `@tumpel/openapi` or `@tumpel/api`, so no public client sees it.

Zod in control-plane costs less per change: one PR in one repo, with no protocol release first. It loses three things:

1. Tenet 4 of `doc/adr/000-tenets.md` makes TypeSpec the single source of truth, and `rules/typespec.md` 1 names the host channel, an internal contract, as part of it.
2. #261 failed on a public model, `Persona`, inside a tenant result. A Tenant API that references public models in one TypeSpec program sees such a change. A hand-written zod copy in control-plane does not see that a tarball bump changed a model it returns.
3. tumpel/protocol already runs a wire lock and its guard for the host channel (EDD-009). The Tenant API reuses both and writes no second guard.

A tenant change ships the way a public change ships today (`rules/typespec.md` 2): a protocol release, then a tumpel PR that bumps the three tarball URLs.

## Versions and skew

Decision D3: `TenantApi` carries `Version` and `Oldest`, with `Oldest` at `Version` or `Version - 1`. The tenant Durable Object serves every version in that window. The client always sends `Version`. Each version has a lock, `tenant-api/v<N>.json`, and the EDD-009 guard fails `npm run generate` on a change to a frozen lock or on a non-additive change to the living one.

| Change to the Tenant API                                               | Kind        |
| ---------------------------------------------------------------------- | ----------- |
| New operation                                                          | Additive    |
| Any change to an existing operation's input                            | New version |
| Any change to an existing operation's result, including an added field | New version |
| A change to a public model that a result references                    | New version |

A new operation is additive because an older instance refuses it retryably (D5). An added result field takes a version, because an older instance never sends it and the newer caller must not accept its absence (R5). An added input field takes a version, because an older instance drops it and runs the old behaviour, as an old `deleteConnector` does with `updatedAt`.

A version bump adds one adapter per changed operation. It turns a `Version - 1` request into the current input, and the current result into the `Version - 1` result. When it cannot, for example when the older input lacks `updatedAt`, it answers `TenantApiVersionUnsupported`. The next deploy raises `Oldest` and deletes the adapters and the older lock.

Decision D4: one deploy of skew is the design point. Every caller ships in the same Worker script as the tenant Durable Object. Cloudflare moves an active instance to new code when it hibernates, or after a default deferral of 300 s ([code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)). So the window needs two versions, unlike the host window, which counts hosts and gates drops (EDD-009). Two deploys inside one restart lag leave an instance two versions behind. It then answers the refusal of D5, which is safe.

## Refusals

Decision D5: the tenant Durable Object answers a request it cannot serve with a typed refusal. It returns the refusal as a result value, because the outcome is expected during a deploy (`rules/errors.md` 5).

| Refusal                       | When                                                                                  | Carries                               |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| `TenantApiVersionUnsupported` | `tenantApiVersion` lies outside `Oldest` to `Version`, or an adapter cannot translate | The instance's `Oldest` and `Version` |
| `TenantOperationUnknown`      | The instance does not know `operation`                                                | The operation                         |
| `TenantRequestInvalid`        | `input` fails the operation's schema                                                  | The zod issues                        |

When the request names a version above the instance's own, or an unknown operation, the instance is the stale side. It returns the refusal, then calls `ctx.abort()`, so Cloudflare drops it and the next call starts an instance on the deployed code. The cost: `abort` also fails the instance's other in-flight calls. A deploy restart fails them too, so the reset moves that failure earlier and shortens the window from minutes to one call.

Each caller turns the first two refusals into its own retryable failure:

1. A Worker handler answers 503 with `Retry-After: 5` and the problem title "Tumpel is updating", with the detail "Try again in a few seconds." An MCP tool returns the same text as a tool error. The CLI shows it.
2. The HostChannel leaves the frame unacknowledged. The supervisor resends it after the next Welcome, as EDD-002 already does for a tenant fault.
3. SessionTimer fails its alarm, and Cloudflare runs the alarm again.

`TenantRequestInvalid` marks a caller bug, so every caller fails it as a 500.

Cloudflare starts an instance that is not running on the latest deployed version ([code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)). So the call after the reset runs the deployed code once the rollout reaches the instance. Slice T1 confirms it on the dev stage.

## Deploy orchestration

Decision D6: the Tenant API closes the window, and no deploy orchestration replaces it. Cloudflare documents no mechanism that keeps the Worker and every Durable Object instance on one version. Its known issues page states that code changes "are released globally in an eventually consistent manner", so a new Worker can call an instance on older code. It tells every user to keep the API between a Worker and its Durable Objects forward and backward compatible ([known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates)).

| Option                                    | What Cloudflare guarantees                                                                                                                                                                                                                                                                                                                                                                                                                               | Cost                                                                                                                                                                                                                                                  | Closes the window                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gradual deployments with version affinity | Each instance keeps one version for a deployment ([with Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)). Requests that share a `Cloudflare-Workers-Version-Key` reach one Worker version, which the platform picks from a hash of the key ([version affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/)) | The release moves from `wrangler deploy` to `wrangler versions upload` and `wrangler versions deploy`. One or two slices                                                                                                                              | No. A request and the instance it calls get their versions independently. Cloudflare states that gradual deployments make mixed versions "even more likely"                                                                                                                                                                        |
| Durable Objects before the Worker         | Inside one script, "you cannot deploy changes to your Durable Object and its Worker independently". A class family in its own Worker, bound through `script_name`, deploys on its own ([architecture guidance](https://developers.cloudflare.com/durable-objects/best-practices/architecture-guidance/#split-workers-by-class-family))                                                                                                                   | One Worker per class family, its tofu resources, a second Workers Builds project and ordered deploys in the release workflow. About five slices. Every shape change then takes two deploys: one the old caller can call, one that drops the old shape | No. The tenant Durable Object calls HostChannel, and HostChannel calls the tenant Durable Object, so no order puts every callee first. The split script's instances still defer new code for up to 300 s                                                                                                                           |
| Force every instance onto the new code    | The `immediate` code update strategy resets each active instance at deploy, in place of the default deferral of up to 300 s. An instance that is not running starts on the latest version ([code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/))                                                                                                                                                  | One line in `wrangler.jsonc`. One slice                                                                                                                                                                                                               | No. The rollout stays eventually consistent, with no stated bound. No Cloudflare API reports when every instance runs the new version. The dashboard's observed split comes from sampled analytics that lag by minutes ([changelog](https://developers.cloudflare.com/changelog/post/2026-08-20-durable-objects-deployments-tab/)) |

The default deferral of up to 300 s, plus propagation, matches the 6 minutes #261 observed. `immediate` shortens that window, and resets every class in the script at each deploy. That drops every HostChannel WebSocket and every waiting `waitTurns`. The Tenant API gets the same short window from `ctx.abort()` (D5). It resets only a stale instance that receives a call it cannot serve, and it stays correct while the rollout lags. Every option above still leaves the compatibility work to the code, and the Tenant API makes that work explicit and checked.

## Migration plan

Decision D7: protocol PR P0 defines Tenant API version 1 for all 110 operations, one input model per operation that mirrors today's arguments by name, with today's results as variant models. T1 bumps the tarballs once, and each later tumpel PR moves one group with no protocol change. A moved method becomes protected in the same PR, so the type checker finds every call site it missed. The old RPC methods and the new entry point run side by side until T7.

| Slice | Change                                                                                                                                | Operations |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P0    | tumpel/protocol: `Tumpel.TenantApi` version 1, refusals, the `tenant-api/v1.json` lock and guard                                      | 110        |
| T1    | Bump the tarballs. Add `handle`, the `tenantApi` client, the refusal mapping and `ctx.abort`. Move personas. Confirm the reset on dev | 5          |
| T2    | Secret sets, pins, config apply, `open`, supervisor updates                                                                           | 14         |
| T3    | Connectors                                                                                                                            | 11         |
| T4    | OpenRouter, CircleCI and Claude setup authorizations                                                                                  | 16         |
| T5    | Prebuilds, then build connections and CircleCI projects, as two PRs                                                                   | 19 + 16    |
| T6    | Sessions and turns                                                                                                                    | 16         |
| T7    | Host lifecycle from HostChannel, SessionTimer and deploy drain                                                                        | 13         |

T5 is two PRs because 35 operations make one review too large. A slice that changes a shape while it moves an operation takes a protocol release before it. No slice changes a shape.

Tests stay low in the stack. One unit test per refusal drives `handle` with a request outside the window, an unknown operation and an invalid input. One adapter test lands with each version bump. The moved operations keep their current tests through the client.

## FAQ

### Why one entry point, and not 110 validated methods?

An unknown method fails inside the Cloudflare runtime before any tenant code runs, so the instance cannot answer it with a refusal or reset itself (D1, D5).

### Why not deploy the Durable Object before the Worker?

One Worker script carries both, so Cloudflare deploys them together. A split into two scripts leaves a call cycle between the tenant Durable Object and HostChannel, so no order puts every callee first (D6).

### Does every field change need a version?

Yes, for an existing operation. The window keeps the previous version, so a bump costs one adapter that the next deploy deletes (D3).

### What does a user see during a deploy?

At most one 503 per tenant instance, "Tumpel is updating. Try again in a few seconds." (D5).

### Why TypeSpec for an internal contract?

Tenant results carry public models, and the TypeSpec guard sees their changes. TypeSpec is also the single source of truth (D2).
