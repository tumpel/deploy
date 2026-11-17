# GitHub connections

## Summary

The Connections screen and the wizard's GitHub step list every GitHub App installation the tenant holds, one per connected account or organization. Each row shows the account login and its status; on Connections an Owner also gets Disconnect. Adding another account or organization always goes through GitHub's own App install page at `https://github.com/apps/<app-slug>/installations/new`, which lists every account and organization the person can reach. The dashboard has no account list of its own.

## Installed connections

| Element       | Purpose                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Account login | The GitHub account the App is installed on                                                      |
| Status badge  | Active (green) or Suspended (yellow)                                                            |
| Disconnect    | Connections only, Owner only: removes the installation from the tenant; the App stays on GitHub |

The list comes from the tenant's stored installations (`GitHubConnections_list`), which needs no GitHub sign-in. A Member sees the same list without Disconnect and without **Add another account or org**. On Connections the card says "Only an Owner connects or disconnects services. Owners are listed under Members."; the wizard says "Only an Owner adds GitHub accounts. Ask an Owner to add them."

## Adding an account or organization

An Owner chooses **Add another account or org**. The button calls `GitHubConnections_start` with the page as `returnUrl` and no `gitHubAccountId`, shows "Opening GitHub..." and stays disabled while the call runs, then sends the browser to the answered `installUrl`. That URL carries no `target_id`, so GitHub shows its account and organization picker. If the call is refused, for example because the stage has no GitHub App or the session expired, the button stays on the page with the problem, its fix and Try again above it.

GitHub's picker shows Install for an account without the App and Configure for one that already has it. Saving on either sends the person back through the control plane (`setup_action=install` or `update`; the App's manifest sets `setup_on_update`), which checks that this person installed the App on that account and links the installation to the tenant. That is also how an installation that exists on GitHub but is not linked to the tenant gets linked. When an organization owner must approve the App first, GitHub returns with `setup_action=request` and the installation appears once they approve.

## Return from GitHub

The control plane sends the browser back to the page that started, with `from=github`:

| Outcome                          | Query added                                      | The dashboard shows                                                  |
| -------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| Linked, or an approval requested | nothing                                          | Banner "Back from GitHub": every linked account is listed below      |
| Refused                          | `refused=<GitHubInstallRefusal>&account=<login>` | Alert "Tumpel did not link <login>" with the reason and the fix      |
| GitHub call failed               | `failed=<detail>`                                | Alert "GitHub did not confirm the installation" with GitHub's detail |

`GitHubInstallRefusal` is `OtherTenant` (another tenant holds the installation: disconnect it there, then add it again), `NotInstaller` (someone else installed the App on that account: ask them to add it, or reinstall it yourself) or `InstallerUnknown` (GitHub has not yet named the installer: add it again in a moment, or reinstall). The banner and the alerts close with their close control, or Esc on the focused banner, which strips `from`, `refused`, `account` and `failed` from the query.

## API needs

1. `GitHubConnections_get`: the stage's GitHub App state (Ready with slug, or AppMissing).
2. `GitHubConnections_list`: every installation the tenant holds, with account login, status and created/updated times.
3. `GitHubConnections_start`: answers an `installUrl` for the App's install page. With `gitHubAccountId`, GitHub opens on that account; without it, GitHub shows the picker. With `returnUrl`, the browser returns to that page with the outcome above.
4. `GitHubConnections_delete`: removes one installation from the tenant.

## Layout

Phone first. Each installation is a row with the login and status badge, and Disconnect on the right on Connections. **Add another account or org** sits below the list and fills the width on a phone. A return banner or alert sits above the list.

## Keyboard and focus

Tab moves through each row's Disconnect in list order, then **Add another account or org**. The "Back from GitHub" banner takes focus when it appears.

## URL

| Screen      | Path                         | Query after a return                                      |
| ----------- | ---------------------------- | --------------------------------------------------------- |
| Wizard      | `/t/<tenantId>/setup/github` | `?from=github`, plus `refused` and `account`, or `failed` |
| Connections | `/t/<tenantId>/connections`  | `?from=github`, plus `refused` and `account`, or `failed` |

## States

Every state is one story of `Dashboard/Connections/ConnectionList`. `Dashboard/FirstRun/GitHubStep` adds `AccountList`, the installed list inside the wizard frame, and `Refused`.

| State                    | Story                                       | Enters on                                 |
| ------------------------ | ------------------------------------------- | ----------------------------------------- |
| Not configured           | `NotConfigured`                             | Stage has no GitHub App                   |
| Connected, empty         | `NotConnected`                              | Tenant holds no installations             |
| Connected, with installs | `Connected`                                 | Tenant holds one or more installations    |
| Member                   | `MemberView`                                | The signed-in person is a Member          |
| Installations loading    | `InstallationsLoading`                      | The installation list is in flight        |
| Installations error      | `InstallationsError`                        | The installation list failed              |
| Opening GitHub           | `AddAnotherAccount`                         | An Owner chose Add another account or org |
| Start refused            | `AddAnotherAccountRefused`                  | `GitHubConnections_start` was refused     |
| Back from GitHub         | `ReturnedFromGitHub`                        | `?from=github`                            |
| Refused                  | `RefusedOtherTenant`, `RefusedNotInstaller` | `?from=github&refused=…&account=…`        |
| Return failed            | `ReturnFailed`                              | `?from=github&failed=…`                   |

### Not configured

The card shows the setup page link for the stage operator to create the App.

### Connected, empty

The card says "No GitHub accounts connected yet." and shows **Add another account or org** for Owners.

### Connected, with installs

The card lists each installation with its login and status, Disconnect for an Owner, and **Add another account or org** below the list.

### Installations loading

"Reading the tenant's GitHub accounts" and two skeleton rows hold the list's space. The card never says "No GitHub accounts connected yet." while the list loads.

### Installations error

The alert names the failed call and the fix. Try again reruns the list. The card never says "No GitHub accounts connected yet." when the list failed.

## CircleCI

CircleCI's OAuth App gets one user token that reaches every org granted on GitHub's one consent screen. Tumpel's tenets rule that out: that token lives for months and reaches every repository the user can reach. A GitHub App with one install per account stays the right route, and GitHub's own picker makes those installs one flow.
