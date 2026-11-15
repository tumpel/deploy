# Dashboard requirements

## Summary

The dashboard is the browser cockpit for one Tumpel tenant. A person signs in and runs hosts, harnesses, personas, secrets, connections, prebuilds, members and sessions, and watch transcripts live. Built on Vite, React, TanStack Query and TanStack Router, it calls the public API through the generated client only, so every screen below names its operations.

## Users and jobs

One operator runs a tenant today. Later a small team of owners and members shares it.

1. Start a session on a repository and one of its issues, and watch the turn live.
2. Steer a running session with the next prompt, then stop or archive it.
3. Enrol a host, see its state and usage, set its labels and revoke it.
4. Pin harness versions and keep personas, their files and their secret sets.
5. Connect GitHub, build providers and later other services.
6. See each repository's latest prebuild and rebuild it.
7. Invite a teammate by email and remove them again.
8. Sign in and set up a new tenant on one page.

## First run

A new operator signs in through Access at `https://<stage>.tumpel.dev` and finishes setup there. The CLI and the device page stay for automation and agents.

When the Access email holds no tenant, the consent page asks for the tenant name that `Tenants_signUp` requires. It then finishes the same sign-in (G22).

The dashboard opens `/t/<tenantId>/setup` until every step reads done. Each step has one button and reads its state from the API. UX picks a checklist or a wizard.

| Step              | The button                                                                                                                            | Done when                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Connect GitHub    | Opens the `installUrl` of `GitHubConnections_start`, which returns to the setup page (G10)                                            | `GitHubConnections_get` reads Connected                                                        |
| Add a host        | Calls `EnrolmentTokens_mint` and shows its `installCommand` fed the `token` on stdin, with the expiry and a copy control              | `Hosts_list` holds an Online host                                                              |
| Connect claude.ai | Shows `https://api.<stage>.tumpel.dev/mcp` with a copy control and two lines: add it in claude.ai as a custom connector, then sign in | G25 lists a claude.ai client                                                                   |
| Apply a config    | Imports a config file, or opens the persona and secret set forms (#4, #14)                                                            | A persona's secret set holds a credential for its harness (`Personas_list`, `SecretSets_list`) |

An import reads a `TenantConfig` file such as `doc/personas/tumpel-dev.json` and shows each schema error with its JSON pointer. It asks for each file a `from` names and each env-sourced value, in password fields. It shows the plan from G23 with its deletes and applies it on confirm (G24). A refusal shows its `Problem` and leaves the step not done.

## Sign-in and tenancy

The dashboard signs in through the control plane's OAuth with PKCE, behind the Cloudflare Access consent page (#2). The token belongs to one principal and acts in one of its tenants. `Identity_whoami` names both.

The tenant id leads every URL: `/t/<tenantId>/sessions/<sessionId>/turns/<turnId>`. Filters sit in the query string, so a reload or a shared link opens the same view. The header's tenant switcher lists the tenants of the signed-in email and keeps one token per tenant. Picking a tenant without a token runs the consent for that tenant and returns to the same path under the new tenant id.

## Screens

| Screen      | Shows and does                                                                     | Operations                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | Host states, box slots, sessions by state, expiring tokens, connection state       | `Hosts_list`, `Hosts_listUsage`, `Sessions_list`, `SecretSets_list`, G5, G13                                                                                                             |
| Sessions    | Sessions filtered by state and host; start, stop, archive                          | `Sessions_list`, `Sessions_start`, `Sessions_startFromIssue`, `Sessions_stop`, `Sessions_archive`, `Personas_list`, `GitHubConnections_listRepositories`, `GitHubConnections_listIssues` |
| Session     | Turns, live transcript, next prompt, failures, snapshots, handovers, stop failures | `Sessions_get`, `Turns_list`, `Turns_get`, `Turns_send`, `Turns_getFailure`, `Transcripts_read`, `Snapshots_list`, `Sessions_listCredentialHandovers`, `Sessions_listStopFailures`       |
| Hosts       | Hosts with state, version, labels and usage; enrol, relabel, revoke                | `Hosts_list`, `Hosts_get`, `Hosts_listUsage`, `EnrolmentTokens_mint`, `Hosts_setLabels`, `Hosts_revoke`, G14                                                                             |
| Harnesses   | The catalog and the tenant's pins; pin and unpin                                   | `HarnessCatalog_list`, `HarnessCatalog_listPins`, `HarnessCatalog_pin`, `HarnessCatalog_unpin`                                                                                           |
| Personas    | Personas with harness, secret set and files; create, edit, delete                  | `Personas_list`, `Personas_get`, `Personas_create`, `Personas_update`, `Personas_delete`, `Personas_uploadFile`, `HarnessCatalog_list`                                                   |
| Secrets     | Secret sets with member names, kinds, providers and expiries; create, edit, delete | `SecretSets_list`, `SecretSets_get`, `SecretSets_create`, `SecretSets_update`, `SecretSets_delete`, G12                                                                                  |
| Connections | Each connection with its state and account; connect, disconnect                    | `GitHubConnections_get`, `GitHubConnections_start`, G5, G6, G10, G15, G16, G17                                                                                                           |
| Prebuilds   | The latest prebuild of each repository; rebuild                                    | `GitHubConnections_listRepositories`, G18, G19, G20, G21                                                                                                                                 |
| Members     | Members with role, open invites; invite, revoke, remove                            | G2, G3, G4                                                                                                                                                                               |
| Account     | The signed-in principal and its devices; sign a device out                         | `Identity_whoami`, `Devices_list`, `Devices_revoke`                                                                                                                                      |

## Screen rules

Start a session reads GitHub as not connected from the `GitHubNotConnected` refusal of `GitHubConnections_listRepositories`, and offers Connect GitHub in place of the pickers. Enrolment shows the minted token and its install command once, with the expiry. The persona file editor lists only the paths the catalog lists for the persona's harness. Per-harness config is the persona's files.

Secret values go into a password field and travel once, in the create or update call. The API holds every value back. A subscription token past its `expiresAt` reads Expired and names the fix.

## Connections

A connection links the tenant to an outside service. Every connection has the same three states and the same three actions:

| State         | Meaning                                               | Action                       |
| ------------- | ----------------------------------------------------- | ---------------------------- |
| NotConfigured | The stage has no app for the service                  | Open the one-time setup page |
| NotConnected  | The stage has an app and the tenant has not linked it | Connect                      |
| Connected     | The tenant holds a link to one account                | Disconnect                   |

For GitHub, NotConfigured is today's `AppMissing`, whose `setupUrl` opens `/github/app/setup`. Connect sends the browser to the `installUrl` of `GitHubConnections_start`. GitHub returns to `/github/app/installed`, which links the installation and sends the browser back (G10). Connected shows the account login and the covered repositories (`GitHubConnections_listRepositories`). Disconnect removes the link (G6) and says to uninstall the App on GitHub too.

A later service adds its own operation group with `get`, `start` and `delete`, and one row in `Connections_list` (G5).

### Build providers

A build provider is a connection kind that runs prebuilds on the tenant's own account and bills the tenant ([RFC: Prebuilds](../RFC/RFC-TUM-Prebuilds.md)). Phase 1 has two. Each card shows its state, the billing account and the trust material, each value with a copy control:

| Provider       | Connect                                                                                                           | Billing account            | Trust material                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions | The installed App, plus a caller workflow in the repository that calls Tumpel's reusable workflow at a pinned tag | The installation's account | The caller workflow                                                                                                                             |
| Namespace      | A one-time registration of the stage's issuer with Namespace Support for the tenant's workspace                   | The Namespace workspace    | Issuer `https://id.<stage>.tumpel.dev`, subject `tenant:<tenantId>:persona:<personaName>:job:prebuild`, audience `federation.namespaceapis.com` |

## Prebuilds

The Prebuilds screen lists each repository the tenant has prebuilt with its latest prebuild (G18). A row shows the state (Dispatched, Building, Converting, Done or Failed), the provider, the input digest, start and finish times, the layer size and a link to the provider's log. Rebuild starts a job even when a prebuild with the same key is stored (G21).

A row shows only the latest prebuild, so a Failed one leaves the row once a newer one starts. The repository's side panel keeps the failure until a later prebuild succeeds. It names the phase that failed (dispatch, build, upload or conversion), the detail with its fix, and the log link.

## Fleet overview

The overview shows numbers the API returns today:

- Hosts by state: Enrolled, Online, Offline, Revoked.
- Per host: the `ReportedHostUsage` fields, free slots (capacity minus running minus warm) and the last report time.
- Sessions by state, by host and by harness.
- Subscription tokens by `expiresAt`, soonest first, with expired ones marked.
- Each connection's state.

The session page shows each turn, snapshot, credential handover and stop failure of one session. Failed turns across the tenant need G13.

The overview refreshes on window focus and after each action. Only the live transcript reads on a timer.

## Live transcript

The view reads `Transcripts_read` with `turnId` and the last cursor, as the RFC decides. When a page moves the cursor, the next read starts at once. Otherwise the view waits 250 ms, doubling to 5 s, as `tumpel transcript read --follow` does. A page that reads `finished` ends the reads, and a Failed turn then shows its `Turns_getFailure` reason and detail.

A compact toggle passes `compact` for a Claude Code turn and is hidden for other harnesses. On reload, the view reads the turn from its first line.

## Errors and signed-out state

Every refusal is a `Problem`. The dashboard shows its `title`, `detail` and `fix`, plus a prefilled link that reports an issue. A 401 switches the whole app to a signed-out state: a persistent notice and a sign-in control that returns to the same URL. On a 403 the view shows Forbidden with its fix. Neither ever renders as an empty list. An empty list names the way to add the first item. An unreachable control plane shows a retry control.

## API gaps

Each signed-in addition also gets an MCP tool and a CLI command.

1. G1 `Identity_listTenants`, and a tenant choice on the consent page. An email holds one principal, which belongs to tenants through memberships.
2. G2 `Members_list`, with roles.
3. G3 `Invitations_create`, `_list` and `_revoke`, and a browser-only `_accept` like `Tenants_signUp`.
4. G4 `Members_remove`, which signs out the member's devices.
5. G5 `Connections_list`: each connection kind with its state and account.
6. G6 `GitHubConnections_delete`.
7. G10 `GitHubConnections_start` takes a return URL on the dashboard's origin.
8. G12 `SecretSetUpdate` takes a member by name alone and keeps its stored value. Today an update needs every value again.
9. G13 `Turns_listForTenant`, filtered by state and start time.
10. G14 The supervisor version the stage serves. The supervisor has no update command yet (OR-1).
11. G15 `Connections_list` holds the build providers with their billing account.
12. G16 `GitHubActionsConnections_get`, `_start` and `_delete`, with the caller workflow to copy.
13. G17 `NamespaceConnections_get`, `_start` and `_delete`. `get` answers the issuer, subject pattern and audience.
14. G18 `Prebuilds_start`, `Prebuilds_list` per repository, `Prebuilds_listLatest` for the newest prebuild of each repository, and `Prebuilds_get` (FR-1).
15. G19 `Prebuild` carries start and finish times, layer bytes and the provider's log URL.
16. G20 `Prebuilds_getFailure`: the failed phase and its fix (FR-5).
17. G21 A rebuild flag on `Prebuilds_start`.
18. G22 The consent page signs up an Access email with no tenant for the client `tumpel-dashboard`: a form, `Tenants_signUp`, then the same consent.
19. G23 `TenantConfigs_plan`: takes a `TenantConfig` and each persona file's digest by its `from` path. It answers each create, update and delete, as `tumpel config plan` prints them.
20. G24 `TenantConfigs_apply`: takes the same document, each persona file's bytes inline or by digest, and the value of every variable the file names. It applies the plan as `tumpel config apply` does and rewrites a kept secret set when every value it names is sent. Its MCP tool refuses values, as the secret-set tools do.
21. G25 `OAuthGrants_list`: the OAuth clients that hold a live token for the caller, with name, redirect origin and last use. `Devices_list` holds device sign-ins only.

## Open questions

1. Does the dashboard register through `OAuth_register` like an MCP client, or ship as a fixed client (#2)?
2. Where does the model list come from? The catalog names a provider and no models (#5).
3. Which actions does a Member role lose against an Owner? Starting and deleting connections, and managing members and invitations.
4. How does Tumpel learn that Namespace Support registered the issuer for a workspace?

## FAQ

**Can the dashboard read a secret value?** No. The API returns no value.
