# EDD-006: The proof

An appendix of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md).

## Summary

Agents prove each release against the deployed control plane and a real host, with no mocks and no person in a browser. A test run signs in, enrols the host, runs turns on Claude Code, restores a session from its snapshots and checks isolation and secrecy. The release passes when every step passes in one run.

## Where it runs

The reference host is a Linux VM on the hypervisor `box`, with a host-passthrough CPU so it exposes KVM, 4 vCPU and 8 GiB. The control plane is the deployed Worker. An agent on the development machine drives the release's CLI and the hosted MCP server.

## Signing in

The test run holds a Cloudflare Access service token. Access issues a JWT for it that carries the token's client id. The Worker var `ACCESS_PROOF_COMMON_NAME` holds that client id. The Worker takes the token as the owner of the test tenant "Tumpel proof". It takes it on two endpoints only: device approve and device deny. `npm run proof -- tumpel login` starts the device flow and approves the device code with the token. The token lives in the runner's environment and never in the repository.

## Steps

1. Sign in. `tumpel whoami` names the test tenant.
2. Enrol. The installer and the release binaries set up the host, which enrols with a freshly minted token and reads Online.
3. Configure. `tumpel config apply` writes a Claude Code persona and its secret set. The set's `ApiKey` or `SubscriptionToken` member takes its value from the runner's environment.
4. First turn. A start names the persona, a model, a small test repository and a prompt, and returns ids before the first line. Lines arrive, and the turn reads Completed.
5. Warm turn. A second turn inside the warm window resumes the paused box and reaches the same harness process.
6. Snapshot. After the quiet delay the snapshot reads Stored.
7. Restore. A stop, then a send, boots a fresh box. A file the first turn wrote is present.
8. Concurrency. Two sessions run a turn each on the host at the same time.
9. Isolation. A Shell box reaches a public website. It fails to reach the host, the other box and every private range.
10. Secrecy. A search of the host's disk and of every transcript finds no copy of the credential. The audit record lists the variable names.
11. Refused credential. A secret set with an invalid key fails its turn with a reason that names the set and how to replace the value.
12. Revoke. Revoking the host closes its connection with 4403, and the supervisor exits naming the revocation.

## Passing

A run passes when all twelve steps pass with no super harness plugged in. A failed step reports its named reason and the tail of the harness's standard error.

## FAQ

**Does a person approve anything?** No. The service token approves the device code.

**Which harnesses does the proof cover?** Claude Code, plus each harness the catalog adds once its image builds.
