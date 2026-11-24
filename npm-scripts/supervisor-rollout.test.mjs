import assert from "node:assert/strict";
import { test } from "node:test";
import { publishCandidate } from "./rollout.mjs";

test("a supervisor change without approval fails before any publication write", async () => {
  const current = { supervisors: [{ supervisorVersion: "1.0.0" }] };
  const proposed = { supervisors: [{ supervisorVersion: "1.1.0" }] };
  await assert.rejects(
    publishCandidate(undefined, proposed, {
      supervisorRolloutApproved: false,
      get: async (key) => {
        assert.equal(key, "current.json");
        return { value: current, etag: '"live"' };
      },
      put: async () => assert.fail("a refused rollout cannot write"),
    }),
    /supervisor rollouts are on hold until the bootstrap release/,
  );
});

test("an approved supervisor change publishes against the live manifest", async () => {
  const current = { supervisors: [{ supervisorVersion: "1.0.0" }] };
  const proposed = { supervisors: [{ supervisorVersion: "1.1.0" }] };
  const writes = [];
  await publishCandidate(undefined, proposed, {
    supervisorRolloutApproved: true,
    get: async () => ({ value: current, etag: '"live"' }),
    put: async (...args) => writes.push(args),
  });
  assert.deepEqual(writes, [["current.json", proposed, { "if-match": '"live"' }]]);
});

test("a CLI change publishes without approval when the supervisor pin stays the same", async () => {
  const current = { supervisors: [{ supervisorVersion: "1.0.0" }], clis: [{ cliVersion: "2.0.0" }] };
  const proposed = { supervisors: [{ supervisorVersion: "1.0.0" }], clis: [{ cliVersion: "2.1.0" }] };
  const writes = [];
  await publishCandidate(undefined, proposed, {
    get: async () => ({ value: current, etag: '"live"' }),
    put: async (...args) => writes.push(args),
  });
  assert.deepEqual(writes, [["current.json", proposed, { "if-match": '"live"' }]]);
});
