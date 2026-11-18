# EDD-006: The proof

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

Agents prove every stage after its deploy, against that stage's control plane and a real host, with no mocks and no person in a browser. A test run signs in, enrols the host, runs turns on Claude Code, restores a session from its snapshots and checks isolation and secrecy. It also checks the issuer and the prebuilds. The stage passes when every step passes in one run.

## Where it runs

The reference host is a Linux VM on the hypervisor `box`, with a host-passthrough CPU so it exposes KVM, 4 vCPU and 8 GiB. The control plane is the stage's deployed Worker. An agent on the development machine drives the hosted MCP server and the CLI of the stage's current release.

`npm run proof:e2e` runs the steps below against the stage that `TUMPEL_STAGE` names, on the host that `TUMPEL_PROOF_HOST` names. It signs in through `npm run proof` with the stage's own Access service token, which OpenTofu manages, and it runs after every deploy of every stage. The `proof` persona's `CLAUDE.md` sits in `doc/personas/proof-tenant/`.

## Signing in

The test run holds a Cloudflare Access service token. Access issues a JWT for it that carries the token's client id. The Worker var `ACCESS_PROOF_COMMON_NAME` holds that client id. The Worker takes the token as the owner of the test tenant "Tumpel proof". It takes it on three endpoints only: device approve, device deny and the OAuth consent page. `npm run proof -- tumpel login` starts the device flow and approves the device code with the token. The token lives in the runner's environment and never in the repository. The subscription token and its expiry come from the runner's own Claude Code credential by default, or from the encrypted key that `TUMPEL_PROOF_CREDENTIAL=dotfiles:<key name>` names, with the expiry in `TUMPEL_PROOF_CREDENTIAL_EXPIRES_AT`.

## Steps

1. Sign in. `tumpel whoami` names the test tenant.
2. Enrol. The run copies the published supervisor to the host. Its installer sets up the host, which enrols with a freshly minted token and reads Online.
3. Configure. `npm-scripts/proof-tenant.mjs` applies `doc/personas/proof-tenant.json`: the `proof`, `refused` and `ticket-worker` personas and their secret sets. The run exports every value the file names, the token's expiry from the credential, so apply writes each set with those values. Each set carries `GITHUB_TOKEN` from `PROOF_GITHUB_TOKEN`.
4. First turn. A start names the persona, a model, a small test repository and a prompt, and returns ids before the first line. Lines arrive, and the turn reads Completed.
5. Warm turn. A second turn inside the warm window resumes the paused box and reaches the same harness process.
6. Snapshot. After the quiet delay the snapshot reads Stored.
7. Restore. `tumpel session stop` leaves the session Stopped. A send then boots a fresh box, and a file the first turn wrote is present.
8. Concurrency. Two sessions run a turn each on the host at the same time.
9. Isolation. A box reaches a public website. It fails to reach the host, the other box and every private range.
10. Secrecy. A search of the host's disk, its journal and every transcript finds no copy of the credential. `tumpel session handovers` lists the variable names.
11. Refused credential. A secret set with an invalid key fails its turn with a reason that names the set and how to replace the value.

## Connector steps

Steps 13 and 14 make every call as a JSON-RPC `tools/call` on `/mcp`, with the bearer token that step 12 redeems.

12. Connector. The run follows the 401 from `/mcp` to both metadata documents, registers a client and signs in with PKCE through the service token. It redeems the code and calls `initialize` with protocol 2025-06-18. Every later call sends the agreed version as `MCP-Protocol-Version`. `tools/list` must list the session tools, and `tumpel_host_list_usage` must list the host that step 2 enrolled.
13. Connector session. `tumpel_session_start` names the persona, repository, model and prompt. The run polls a compact `tumpel_transcript_read` by cursor every 2 s. A turn fails with no line in 180 s (60 s claim, 120 s first line) or past 3,600 s. `tumpel_turn_get` must read Completed, or `tumpel_turn_failure` names the reason. Each turn needs an assistant text line, one that does not open with a tool call like `[Bash] ...`. `tumpel_turn_send` repeats this with a second prompt. After `tumpel_session_stop`, `tumpel_session_get` must read Stopped. It times each turn to ids, first line and finish, counts the polls and times the stop.
14. Goal turn. `tumpel_turn_send` sends the session of step 7 a prompt that appends a line to a file and counts its lines, with the goal that the count reads 3. The turn must read Completed and read back its goal. Its raw transcript must hold exactly one `result` line, as its last line, and a tool result must print 3, so the turn ended after the goal loop and not at its first stop.

## Issuer and prebuild steps

15. Issuer. Discovery and the JWKS answer on `id.<stage>.tumpel.dev` and name the stage's issuer, its JWKS URL and RS256. Any other path there answers 404. The JWKS must publish at least one key. The run mints no token.
16. Prebuild refused. `tumpel connection list` reads the GitHubActions, CircleCI and Namespace rows, and none is Connected. A prebuild start on the proof repository names each provider in turn. Each start is refused `Build provider not connected` (NoBuildProvider) with that provider's name, and the repository then has no prebuild.
17. Prebuild GitHub Actions. The step is skipped until `TUMPEL_PROOF_PREBUILD_REPO` names a fixture repository of the App installation's account. The run connects GitHub Actions with the caller workflow `.github/workflows/tumpel-prebuild.yml` and starts a rebuild on the fixture. The start commits that caller workflow when the fixture lacks it or holds an older one, and the commit's push starts the run; otherwise the start dispatches it. Within the dispatch and build budgets the prebuild must read Converting. A second start must answer the same prebuild. The run then deletes the GitHub Actions connection.
18. Revoke. Revoking the host closes its connection with 4403, and the supervisor exits naming the revocation.

## Passing

A run passes when every step passes with no super harness plugged in. A failed step reports its named reason and the tail of the harness's standard error.

## FAQ

**Does a person approve anything?** No. The service token approves the device code and the connector's consent.

**Which harnesses does the proof cover?** Claude Code, plus each harness the catalog adds once its layer builds.
