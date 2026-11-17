# GitHub connections

## Summary

The GitHub section of Connections, and the wizard's GitHub step, list every GitHub App installation the tenant holds, one per connected account or organization. Each row is the account login, which opens the installation's settings on GitHub. On Connections an Owner also gets Disconnect on each row. One **Add new** button sits below the list. It goes through GitHub's own App install page at `https://github.com/apps/<app-slug>/installations/new`, which lists every account and organization the person can reach.

## Installed connections

| Element       | Purpose                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account login | Opens the installation on GitHub in a new tab: `https://github.com/organizations/<login>/settings/installations/<installationId>` for an organization, `https://github.com/settings/installations/<installationId>` for a user |
| Disconnect    | Connections only, Owner only: removes the installation from the tenant; the App stays on GitHub                                                                                                                                |

The list comes from the tenant's stored installations (`GitHubConnections_list`), whose `accountType` picks the settings URL. A Member sees the same list without Disconnect and without **Add new**. On Connections the card says "Only an Owner connects or disconnects services. Owners are listed under Members."; the wizard says "Only an Owner adds GitHub accounts. Ask an Owner to add them."

## Adding an account or organization

An Owner chooses **Add new**. The button calls `GitHubConnections_start` with the page as `returnUrl` and no `gitHubAccountId`, shows "Opening GitHub..." and stays disabled while the call runs, then sends the browser to the answered `installUrl`. GitHub shows its account and organization picker. If the call is refused, the problem, its fix and Try again appear above the button.

GitHub's picker shows Install for an account without the App and Configure for one that already has it. Saving on either sends the person back through the control plane (`setup_action=install` or `update`; the App's manifest sets `setup_on_update`), which checks that this person installed the App on that account and links the installation to the tenant. When an organization owner must approve the App first, the installation appears once they approve.

## Return from GitHub

The control plane sends the browser back to the page that started, with `from=github`. A link adds nothing more, and the list shows the new account. A refusal adds `refused=<GitHubInstallRefusal>&account=<login>` and the section shows "Tumpel did not link <login>" with the reason and the fix. A failed GitHub call adds `failed=<detail>` and the section shows "GitHub did not confirm the installation" with GitHub's detail. Close strips `from`, `refused`, `account` and `failed` from the query.

## States

Every state is one story of `Dashboard/Connections/ConnectionList`.

| State                 | Story                                       | Enters on                             |
| --------------------- | ------------------------------------------- | ------------------------------------- |
| Not configured        | `NotConfigured`                             | Stage has no GitHub App               |
| None connected        | `NotConnected`                              | Tenant holds no installations         |
| Several connected     | `Connected`                                 | Tenant holds installations            |
| Member                | `MemberView`                                | The signed-in person is a Member      |
| Installations loading | `InstallationsLoading`                      | The installation list is in flight    |
| Installations error   | `InstallationsError`                        | The installation list failed          |
| Opening GitHub        | `AddNew`                                    | An Owner chose Add new                |
| Start refused         | `AddNewRefused`                             | `GitHubConnections_start` was refused |
| Refused               | `RefusedOtherTenant`, `RefusedNotInstaller` | `?from=github&refused=…&account=…`    |
| Return failed         | `ReturnFailed`                              | `?from=github&failed=…`               |

## CircleCI

CircleCI's OAuth App gets one user token that reaches every org granted on GitHub's one consent screen. Tumpel's tenets rule that out: that token lives for months and reaches every repository the user can reach. A GitHub App with one install per account is the right route, and GitHub's own picker makes those installs one flow.
