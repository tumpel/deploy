# Dashboard requirements

## Summary

The dashboard is the browser cockpit for one Tumpel tenant. A person signs in with Cloudflare Access and picks a tenant. From there they run hosts, harnesses, personas, secrets, connections, members and sessions, and watch transcripts live. The app runs on Vite and React with TanStack Query and TanStack Router. It calls the public API through the generated client only, so every screen below names the operations it uses. An operation the API lacks is listed under API gaps as a small addition.

## Users and jobs

Today one operator runs a tenant alone. Later a small team shares a tenant, with one or more owners and any number of members.

1. Start a session on a repository and one of its issues, and watch the turn live.
2. Steer a running session with the next prompt, then stop or archive it.
3. Enrol a host, see its state and usage, set its labels and revoke it.
4. See the fleet at a glance: free box slots, sessions by state, failed turns.
5. Pin harness versions and keep personas, their files and their secret sets.
6. Enter a credential once and know when a subscription token expires.
7. Connect GitHub, and later other services, through OAuth.
8. Invite a teammate by email and remove them again.

## Sign-in and tenancy

The dashboard signs in through the control plane's OAuth with PKCE, behind the Cloudflare Access consent page (#2). The token belongs to one principal, and a principal belongs to one tenant. `Identity_whoami` names both.

The tenant id leads every URL: `/t/<tenantId>/sessions/<sessionId>/turns/<turnId>`. Filters sit in the query string, so a reload or a shared link opens the same view. The header holds a tenant switcher. It lists the tenants of the signed-in email and keeps one token per tenant. Picking a tenant without a token runs the consent for that tenant and returns to the same path under the new tenant id.

Today an email holds a principal in one tenant only, so the switcher needs G1.

## Screens

| Screen      | Shows and does                                                                     | Operations                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | Host states, box slots, sessions by state, expiring tokens, connection state       | `Hosts_list`, `Hosts_listUsage`, `Sessions_list`, `SecretSets_list`, G5, G13                                                                                                       |
| Sessions    | Sessions filtered by state and host; start, stop, archive                          | `Sessions_list`, `Sessions_start`, `Sessions_stop`, `Sessions_archive`, `Personas_list`, G7, G8, G9, G11                                                                           |
| Session     | Turns, live transcript, next prompt, failures, snapshots, handovers, stop failures | `Sessions_get`, `Turns_list`, `Turns_get`, `Turns_send`, `Turns_getFailure`, `Transcripts_read`, `Snapshots_list`, `Sessions_listCredentialHandovers`, `Sessions_listStopFailures` |
| Hosts       | Hosts with state, version, labels and usage; enrol, relabel, revoke                | `Hosts_list`, `Hosts_get`, `Hosts_listUsage`, `EnrolmentTokens_mint`, `Hosts_setLabels`, `Hosts_revoke`, G14                                                                       |
| Harnesses   | The catalog and the tenant's pins; pin and unpin                                   | `HarnessCatalog_list`, `HarnessCatalog_listPins`, `HarnessCatalog_pin`, `HarnessCatalog_unpin`                                                                                     |
| Personas    | Personas with harness, secret set, git author and files; create, edit, delete      | `Personas_list`, `Personas_get`, `Personas_create`, `Personas_update`, `Personas_delete`, `Personas_uploadFile`, `HarnessCatalog_list`                                             |
| Secrets     | Secret sets with member names, kinds, providers and expiries; create, edit, delete | `SecretSets_list`, `SecretSets_get`, `SecretSets_create`, `SecretSets_update`, `SecretSets_delete`, G12                                                                            |
| Connections | Each connection with its state and account; connect, disconnect                    | `GitHubConnections_get`, `GitHubConnections_start`, G5, G6, G10                                                                                                                    |
| Members     | Members with role, open invites; invite, revoke, remove                            | G2, G3, G4                                                                                                                                                                         |
| Account     | The signed-in principal and its devices; sign a device out                         | `Identity_whoami`, `Devices_list`, `Devices_revoke`                                                                                                                                |

## Screen rules

Enrolment shows the minted token and its install command once, with the expiry. The persona file editor lists only the paths the catalog lists for the persona's harness. Per-harness config is the persona's files: the tenant holds no other config per harness.

Secret values go into a password field and travel once, in the create or update call. The API holds every value back. It returns each member's `updatedAt` with its name, kind, provider and expiry. A subscription token past its `expiresAt` reads Expired and names the fix.

An edit in the dashboard changes the live tenant. The next `tumpel config plan` against the tenant's config file shows it as a change.

## Connections

A connection links the tenant to an outside service through OAuth. GitHub is the first. Every connection has the same three states and the same three actions:

| State         | Meaning                                               | Action                       |
| ------------- | ----------------------------------------------------- | ---------------------------- |
| NotConfigured | The stage has no app for the service                  | Open the one-time setup page |
| NotConnected  | The stage has an app and the tenant has not linked it | Connect                      |
| Connected     | The tenant holds a link to one account                | Disconnect                   |

For GitHub, NotConfigured is today's `AppMissing`, and its `setupUrl` opens `/github/app/setup`. That page creates the stage's GitHub App once from GitHub's manifest flow. Connect calls `GitHubConnections_start` and sends the browser to its `installUrl`. GitHub returns to `/github/app/installed`, which links the installation and sends the browser back to the Connections screen (G10). Connected shows the account login and the covered repositories (G7). Disconnect removes the link (G6) and says to uninstall the App on GitHub as well.

A later service adds its own operation group with `get`, `start` and `delete`, and one row in `Connections_list` (G5).

## Fleet overview

The overview shows numbers the API returns today, and nothing derived beyond counts and sums:

- Hosts by state: Enrolled, Online, Offline, Revoked.
- Per host: `boxCapacity`, `boxesRunning`, `boxesWarm`, free slots (capacity minus running minus warm), `loadAverage`, `memoryAvailableMib` and the time of the last report.
- Sessions by state, by host and by harness.
- Subscription tokens by `expiresAt`, soonest first, with expired ones marked.
- The GitHub connection state.

The session page holds the numbers of one session. Turns show their state, `lineCount` and duration. Snapshots show `uploadedBytes` or the failure reason. Handovers show its variable names and `repositoryCredentialSource`, and each stop failure its reason and detail. Failed turns across the tenant need G13.

The overview refreshes on window focus and after each action. Only the live transcript reads on a timer.

## Live transcript

A turn's transcript reads through `Transcripts_read` with `turnId` and `after`, as the RFC decides. Each page appends its lines and moves the cursor. When the cursor moved, the next read starts at once. When it did not, the view waits 250 ms, doubling to 5 s, as `tumpel transcript read --follow` does. The reads end at a page whose `finished` is true. The view then reads `Turns_get`, and for a Failed turn it shows `Turns_getFailure` with its reason and detail.

A compact toggle passes `compact` for a Claude Code turn and is hidden for other harnesses. The cursor sits in no URL. A reload reads the turn from its first line.

## Errors and signed-out state

Every refusal is a `Problem`, and the dashboard shows its `title`, `detail` and `fix`, plus a prefilled link that reports an issue. A 401 switches the whole app to a signed-out state: a persistent notice and a sign-in control that returns to the same URL. On a 403 the view shows Forbidden with its fix. Neither ever renders as an empty list. Only a genuine empty answer renders as empty, and an empty list names the way to add the first item. When the control plane does not answer, the view says so and shows a retry control.

## API gaps

Each signed-in addition is also one MCP tool and one CLI command, as the parity check requires.

1. G1 `Identity_listTenants`: the tenants of the caller's email. The consent page takes a tenant choice. Principals become unique per tenant and email, which changes the central store.
2. G2 `Members_list`: the tenant's principals with role.
3. G3 `Invitations_create` (email and role), `Invitations_list`, `Invitations_revoke`, and the browser-only `Invitations_accept`, signed in by the identity assertion like `Tenants_signUp`. An email with no invite and no tenant gets `NotInvited`.
4. G4 `Members_remove`: deletes a principal and signs out its devices.
5. G5 `Connections_list`: one row per connection kind with its state and account login.
6. G6 `GitHubConnections_delete`: removes the tenant's installation link.
7. G7 `GitHubConnections_listRepositories`: the repositories the installation covers.
8. G8 `GitHubConnections_listIssues`: the open issues of one covered repository.
9. G9 `Sessions_start` takes an issue number; the control plane reads the issue and builds the prompt (#5).
10. G10 `GitHubConnections_start` takes a return URL on the dashboard's origin, where the installed callback sends the browser.
11. G11 `Session` carries its last turn's id, state and time (#7).
12. G12 `SecretSetUpdate` takes a Stored member, a name with no value that keeps its stored value, as `PersonaFileWrite` does. Today an update needs every value again.
13. G13 `Turns_listForTenant`: the tenant's turns, filtered by state and by a start time.
14. G14 The supervisor version the stage serves, so the Hosts screen flags an outdated host. The supervisor has no update command yet (OR-1).

## Open questions

1. Does the dashboard register through `OAuth_register` like an MCP client, or ship as a fixed client (#2)?
2. Where does the model list come from? The catalog names a provider and no models (#5).
3. Which actions does a Member role lose against an Owner?

## FAQ

**Can the dashboard read a secret value?** No. The API returns no value.

**How does a person work in two tenants?** Through the tenant switcher, which holds one token per tenant (G1).

**Does the transcript stream?** It reads pages with a cursor until one reads `finished`.
