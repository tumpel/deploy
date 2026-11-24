import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advancePublishedCandidate, assembleCandidate, latestCheckedCommit } from "./assemble-rc.mjs";
import { candidateSource } from "./candidate-source.mjs";
import {
  activateCandidate,
  candidateFor,
  checkedCandidate,
  exactChecks,
  freezeCandidate,
  hash,
  publishCandidate,
  readCandidate,
  readyClients,
  supervisorRolloutAllowed,
  verifyDashboard,
} from "./rollout.mjs";

test("today's pin PR and release without evidence retain their deployment and publication effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rollout-test-"));
  try {
    const pins = { controlPlane: "a".repeat(40), infra: "b".repeat(40), cli: "1.0.0-rc.24", supervisor: "0.3.0-rc.27" };
    const candidate = candidateFor(readCandidate(join(dir, "release-candidate.json")), pins, "dev");
    const mutations = [];
    const notices = [];
    await activateCandidate(candidate, {
      pins,
      notice: (message) => notices.push(message),
      handoff: async () => assert.fail("the legacy path does not require the new infra fingerprint gate"),
      readiness: async () => assert.fail("today's pipeline produces no readiness record"),
      github: async () => assert.fail("a manual pin keeps its existing checks policy"),
      dashboard: async () => mutations.push("dashboard"),
      migrate: async () => mutations.push("migrations"),
      api: async () => mutations.push("API"),
    });
    const manifest = {
      releaseVersion: "0.0.0-aaaaaaaaaaaa",
      clis: [{ cliVersion: pins.cli }],
      supervisors: [{ supervisorVersion: pins.supervisor }],
    };
    await publishCandidate(candidate, manifest, {
      notice: (message) => notices.push(message),
      get: async (key) => {
        assert.equal(key, "current.json");
        return { value: { ...manifest, clis: [{ cliVersion: "1.0.0-rc.23" }] }, etag: '"live"' };
      },
      github: async () => assert.fail("the legacy release adds no exact-SHA gate"),
      readiness: async () => assert.fail("the legacy release adds no readiness gate"),
      put: async (key, value, conditions) => mutations.push([key, value, conditions]),
    });
    assert.deepEqual(mutations, [
      "dashboard",
      "migrations",
      "API",
      ["current.json", manifest, { "if-match": '"live"' }],
    ]);
    assert.equal(notices.length, 2);
    assert.ok(notices.every((message) => message.startsWith("::notice::Candidate client evidence is absent;")));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a PR supervisor change needs the latest approval label from a human admin for this head", async () => {
  const repository = "tumpel/deploy";
  const label = { name: "supervisor-rollout-approved" };
  for (const [login, type, permission, expected] of [
    ["mvhenten", "User", "admin", true],
    ["writer", "User", "write", false],
    ["tumpel-dev[bot]", "Bot", "admin", false],
    ["github-actions", "User", "admin", false],
  ]) {
    const sender = { login, type, id: 7 };
    const event = { action: "labeled", label, pull_request: { number: 75 }, sender };
    const api = async (path, paginate) => {
      if (path === "repos/tumpel/deploy/issues/75/events?per_page=100") {
        assert.equal(paginate, true);
        return [[{ event: "labeled", label, actor: sender }]];
      }
      assert.ok(type === "User" && login !== "github-actions", "bot approvals never reach the permissions check");
      assert.equal(path, `repos/tumpel/deploy/collaborators/${login}/permission`);
      return { permission, user: sender };
    };
    assert.equal(
      await supervisorRolloutAllowed("1.0.0", "1.1.0", { repository, eventName: "pull_request", event }, api),
      expected,
      login,
    );
  }
  const sender = { login: "mvhenten", type: "User", id: 7 };
  const event = { action: "labeled", label, pull_request: { number: 75 }, sender };
  const api = async (path) => {
    assert.equal(path, "repos/tumpel/deploy/issues/75/events?per_page=100");
    return [[{ event: "labeled", label, actor: sender }], [{ event: "unlabeled", label, actor: sender }]];
  };
  assert.equal(
    await supervisorRolloutAllowed("1.0.0", "1.1.0", { repository, eventName: "pull_request", event }, api),
    false,
  );
  assert.equal(
    await supervisorRolloutAllowed(
      "1.0.0",
      "1.1.0",
      { repository, eventName: "pull_request", event: { ...event, action: "synchronize" } },
      async () => assert.fail("a push needs a new label event"),
    ),
    false,
  );
});

test("publication accepts only a supervisor rollout requested by a human admin", async () => {
  const current = { supervisors: [{ supervisorVersion: "1.0.0" }] };
  const manifest = { supervisors: [{ supervisorVersion: "1.1.0" }] };
  for (const [eventName, actor, triggeringActor, requested, permission, allowed] of [
    ["workflow_dispatch", "kate", "kate", true, "admin", true],
    ["workflow_dispatch", "writer", "writer", true, "write", false],
    ["workflow_dispatch", "writer", "kate", true, "admin", false],
    ["workflow_dispatch", "github-actions", "github-actions", true, "admin", false],
    ["workflow_dispatch", "kate", "kate", false, "admin", false],
    ["push", "kate", "kate", true, "admin", false],
  ]) {
    const writes = [];
    const publish = publishCandidate(undefined, manifest, {
      approval: { repository: "tumpel/deploy", eventName, actor, triggeringActor, requested },
      approvalApi: async (path) => {
        assert.equal(path, `repos/tumpel/deploy/collaborators/${actor}/permission`);
        return { permission, user: { login: actor, type: "User" } };
      },
      get: async (key) => {
        assert.equal(key, "current.json");
        return { value: current, etag: '"live"' };
      },
      put: async (...args) => writes.push(args),
    });
    if (allowed) await publish;
    else await assert.rejects(publish, /Supervisor rollouts are on hold/);
    assert.deepEqual(writes, allowed ? [["current.json", manifest, { "if-match": '"live"' }]] : []);
  }
});

test("publication checks ancestry and writes against the same current manifest read", async () => {
  const current = { commit: "a".repeat(40), supervisors: [{ supervisorVersion: "1.0.0" }] };
  const proposed = { commit: "b".repeat(40), supervisors: [{ supervisorVersion: "1.0.0" }] };
  for (const superseded of [true, false]) {
    const effects = [];
    const published = await publishCandidate(undefined, proposed, {
      get: async (key) => {
        effects.push(["read", key]);
        return { value: current, etag: '"live"' };
      },
      skipSuperseded: (manifest) => {
        effects.push(["ancestry", manifest.commit]);
        return superseded;
      },
      put: async (...args) => effects.push(["write", ...args]),
    });
    assert.equal(published, !superseded);
    const reads = [
      ["read", "current.json"],
      ["ancestry", current.commit],
    ];
    assert.deepEqual(
      effects,
      superseded ? reads : [...reads, ["write", "current.json", proposed, { "if-match": '"live"' }]],
    );
  }
});

test("assembly without evidence retains historical green selection and pin-before-release order", async () => {
  const reads = [];
  const sha = await latestCheckedCommit("tumpel/control-plane", "a".repeat(40), async (path) => {
    reads.push(path);
    if (path.includes("/actions/runs?")) return { workflow_runs: [{ name: "checks", head_sha: "c".repeat(40) }] };
    assert.equal(path, `/repos/tumpel/control-plane/compare/${"a".repeat(40)}...${"c".repeat(40)}`);
    return { status: "ahead" };
  });
  assert.equal(sha, "c".repeat(40));
  assert.equal(reads.length, 2);
  const effects = [];
  await assembleCandidate(undefined, {
    notice: (message) => effects.push(message),
    advance: async () => effects.push("main"),
    tag: async () => effects.push("tag"),
    publish: async () => effects.push("release dispatch"),
  });
  assert.match(effects[0], /^::notice::/);
  assert.deepEqual(effects.slice(1), ["main", "tag", "release dispatch"]);
  await advancePublishedCandidate(undefined, async () => assert.fail("legacy publication does not push main again"));
});

test("candidate gates use explicit published client and consumer inputs", async (t) => {
  const candidate = freezeCandidate({
    stage: "dev",
    createdAt: 1000,
    pins: { controlPlane: "a".repeat(40), infra: "b".repeat(40), cli: "1.0.0-rc.2", supervisor: "1.0.0-rc.3" },
    protocol: "1.0.0-rc.4",
    clients: {
      cli: {
        version: "1.0.0-rc.2",
        sha: "c".repeat(40),
        protocol: "1.0.0-rc.4",
        binaries: [{ architecture: "Amd64", sha256: hash("cli") }],
      },
      supervisor: {
        version: "1.0.0-rc.3",
        sha: "d".repeat(40),
        protocol: "1.0.0-rc.4",
        binaries: [{ architecture: "Amd64", sha256: hash("supervisor") }],
      },
    },
    dashboard: {
      version: "0.9.0",
      sha: "f".repeat(40),
      url: "https://github.com/tumpel/dashboard/releases/download/v0.9.0/dashboard.tgz",
      sha256: hash("tarball"),
      files: [{ path: "index.html", sha256: hash("<head></head>B") }],
    },
  });
  const ready = {
    candidateId: candidate.candidateId,
    stage: "dev",
    scope: "TumpelRun",
    inventoryComplete: true,
    observedAt: 1000,
    status: "Ready",
    supervisors: [{ hostId: "stage-host", online: true, supervisorVersion: "1.0.0-rc.3" }],
    consumers: [
      { repository: "tumpel/cli", kind: "Cli", sha: "c".repeat(40), protocol: "1.0.0-rc.4", status: "Ready" },
      {
        repository: "tumpel/supervisor",
        kind: "Supervisor",
        sha: "d".repeat(40),
        protocol: "1.0.0-rc.4",
        status: "Ready",
      },
      { repository: "tumpel/control-plane", kind: "Mcp", sha: "a".repeat(40), protocol: "1.0.0-rc.4", status: "Ready" },
    ],
  };
  const manifest = {
    clis: [{ cliVersion: "1.0.0-rc.2", architecture: "Amd64", sha256: hash("cli") }],
    supervisors: [{ supervisorVersion: "1.0.0-rc.3", architecture: "Amd64", sha256: hash("supervisor") }],
  };

  await t.test("absence is optional; malformed, stale-pin and wrong-stage evidence is terminal", () => {
    assert.equal(candidateFor({}, candidate.pins, "dev"), undefined);
    assert.deepEqual(candidateFor(candidate, candidate.pins, "dev"), candidate);
    assert.throws(() => candidateFor(candidate, { ...candidate.pins, cli: "9.0.0" }, "dev"), /does not match/);
    assert.throws(() => candidateFor(candidate, candidate.pins, "prod"), /does not match/);
    assert.throws(() => checkedCandidate({ ...candidate, createdAt: 2000 }), /changed after freezing/);
  });

  await t.test("readiness failures precede every publication write and leave the next candidate free", async () => {
    for (const evidence of [undefined, { ...ready, status: "Failed" }, { ...ready, observedAt: 0 }]) {
      const writes = [];
      await assert.rejects(
        publishCandidate(candidate, manifest, {
          github: async (path) => ({
            workflow_runs: [
              {
                id: 1,
                head_sha: new URL(`https://api.github.com${path}`).searchParams.get("head_sha"),
                head_branch: "main",
                event: "push",
                status: "completed",
                conclusion: "success",
              },
            ],
          }),
          readiness: async () => evidence,
          get: async (key) => assert.equal(key, "current.json", "failed readiness cannot reach stage ownership"),
          put: async (key) => writes.push(key),
          clock: { now: () => 1000, sleep: async () => assert.fail("terminal readiness errors cannot wait") },
        }),
      );
      assert.deepEqual(writes, []);
    }
  });

  await t.test("a supervisor hold blocks evidenced publication before the stage claim", async () => {
    const current = { supervisors: [{ supervisorVersion: "1.0.0-rc.1" }] };
    await assert.rejects(
      publishCandidate(candidate, manifest, {
        github: async (path) => ({
          workflow_runs: [
            {
              id: 1,
              head_sha: new URL(`https://api.github.com${path}`).searchParams.get("head_sha"),
              head_branch: "main",
              event: "push",
              status: "completed",
              conclusion: "success",
            },
          ],
        }),
        readiness: async () => ready,
        get: async (key) => {
          assert.equal(key, "current.json");
          return { value: current, etag: '"live"' };
        },
        put: async () => assert.fail("a refused rollout cannot claim or write"),
        clock: { now: () => 1000, sleep: async () => assert.fail("ready publication cannot wait") },
      }),
      /Supervisor rollouts are on hold until the bootstrap release/,
    );
  });

  await t.test("publication orders readiness, claim, manifest, stage read-back and prepared receipt", async () => {
    const effects = [];
    await publishCandidate(candidate, manifest, {
      approval: {
        repository: "tumpel/deploy",
        eventName: "workflow_dispatch",
        actor: "mvhenten",
        triggeringActor: "mvhenten",
        requested: true,
      },
      approvalApi: async () => ({ permission: "admin", user: { login: "mvhenten", type: "User" } }),
      github: async (path) => ({
        workflow_runs: [
          {
            id: 1,
            head_sha: new URL(`https://api.github.com${path}`).searchParams.get("head_sha"),
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
      readiness: async () => {
        effects.push("ready");
        return ready;
      },
      get: async (key) => {
        assert.ok(["rollout.json", "current.json"].includes(key));
        return undefined;
      },
      put: async (key, value, conditions) => {
        effects.push(key);
        if (key === "rollout.json") assert.deepEqual(conditions, { "if-none-match": "*" });
        if (key === "current.json") assert.deepEqual(value, manifest);
      },
      endpoint: async () => {
        effects.push("read-back");
        return manifest;
      },
      transport: async (url) => new Response(url.includes("/cli/") ? "cli" : "supervisor"),
      clock: { now: () => 1000, sleep: async () => assert.fail("ready publication cannot wait") },
    });
    assert.deepEqual(effects, [
      "ready",
      "rollout.json",
      "current.json",
      "read-back",
      `prepared/${candidate.candidateId}.json`,
    ]);
  });

  await t.test("failed publication restores the old manifest and frees its stage claim", async () => {
    for (const failure of ["write", "read-back", "prepared"]) {
      const effects = [];
      const old = { releaseVersion: "old", supervisors: manifest.supervisors };
      await assert.rejects(
        publishCandidate(candidate, manifest, {
          github: async (path) => ({
            workflow_runs: [
              {
                id: 1,
                head_sha: new URL(`https://api.github.com${path}`).searchParams.get("head_sha"),
                head_branch: "main",
                event: "push",
                status: "completed",
                conclusion: "success",
              },
            ],
          }),
          readiness: async () => ready,
          get: async (key) => (key === "current.json" ? { value: old, etag: '"old"' } : undefined),
          put: async (key, value, conditions) => {
            if (key === "rollout.json" && value === null) {
              assert.deepEqual(conditions, { "if-match": '"claim"' });
              effects.push("free stage");
              return '"released"';
            }
            if (key === "rollout.json") {
              effects.push("claim");
              return '"claim"';
            }
            if (key.startsWith("prepared/")) throw new Error("prepared failed");
            assert.equal(key, "current.json");
            if (value === old) {
              assert.deepEqual(conditions, { "if-match": '"manifest"' });
              effects.push("restore old manifest");
              return '"restored"';
            }
            effects.push("publish manifest");
            if (failure === "write") throw new Error("write failed");
            return '"manifest"';
          },
          endpoint: async () => (failure === "read-back" ? old : manifest),
          transport: async (url) => new Response(url.includes("/cli/") ? "cli" : "supervisor"),
          clock: { now: () => 1000, sleep: async () => assert.fail("ready publication cannot wait") },
        }),
        /write failed|differs from publication|prepared failed/,
      );
      assert.deepEqual(
        effects,
        failure === "write"
          ? ["claim", "publish manifest", "free stage"]
          : ["claim", "publish manifest", "restore old manifest", "free stage"],
      );
    }
  });

  await t.test("evidenced assembly delegates pin advancement to successful release completion", async () => {
    const effects = [];
    await assembleCandidate(candidate, {
      advance: async () => assert.fail("dispatch does not prove publication"),
      tag: async () => effects.push("tag"),
      publish: async () => effects.push("dispatch"),
    });
    assert.deepEqual(effects, ["tag", "dispatch"]);
    await advancePublishedCandidate(candidate, async () => effects.push("main after publication"));
    assert.deepEqual(effects, ["tag", "dispatch", "main after publication"]);
    await assert.rejects(
      assembleCandidate(candidate, {
        tag: async () => undefined,
        publish: async () => {
          throw new Error("dispatch failed");
        },
        advance: async () => assert.fail("dispatch failure cannot advance main"),
      }),
      /dispatch failed/,
    );
  });

  await t.test("a different candidate can claim a stage released by failed publication", async () => {
    const next = freezeCandidate({ ...candidate, createdAt: 2000 });
    const claims = [];
    await publishCandidate(next, manifest, {
      github: async (path) => ({
        workflow_runs: [
          {
            id: 1,
            head_sha: new URL(`https://api.github.com${path}`).searchParams.get("head_sha"),
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
      readiness: async () => ({ ...ready, candidateId: next.candidateId, observedAt: 2000 }),
      get: async (key) =>
        key === "rollout.json" ? { value: null, etag: '"released"' } : { value: manifest, etag: '"live"' },
      put: async (key, value, conditions) => {
        if (key === "rollout.json") claims.push({ value, conditions });
        return '"written"';
      },
      endpoint: async () => manifest,
      transport: async (url) => new Response(url.includes("/cli/") ? "cli" : "supervisor"),
      clock: { now: () => 2000, sleep: async () => assert.fail("ready publication cannot wait") },
    });
    assert.deepEqual(claims, [{ value: { candidateId: next.candidateId }, conditions: { "if-match": '"released"' } }]);
  });

  await t.test("every online supervisor must match within ten observations and nine sleeps", async () => {
    let now = 1000;
    let observations = 0;
    const sleeps = [];
    await assert.rejects(
      readyClients(candidate, {
        read: async () => {
          observations += 1;
          return {
            ...ready,
            observedAt: now,
            supervisors: [{ hostId: "old", online: true, supervisorVersion: "0.9.0" }],
          };
        },
        clock: {
          now: () => now,
          sleep: async (delay) => {
            sleeps.push(delay);
            now += delay;
          },
        },
      }),
      /timed out after 10 observations/,
    );
    assert.equal(observations, 10);
    assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000]);
    assert.equal(now, 512000);
  });

  await t.test(
    "candidate activation preserves dashboard, migrations and API order with rechecked evidence",
    async () => {
      const effects = [];
      await activateCandidate(candidate, {
        pins: candidate.pins,
        handoff: async () => ({ infra_fingerprint: "b".repeat(40) }),
        lease: async () => ({ candidateId: candidate.candidateId }),
        prepared: async () => ({ candidateId: candidate.candidateId, manifest }),
        github: async (path) => ({
          workflow_runs: [
            {
              id: 1,
              head_sha: new URL(`https://api.github.com${path}`).searchParams.get("head_sha"),
              head_branch: "main",
              event: "push",
              status: "completed",
              conclusion: "success",
            },
          ],
        }),
        readiness: async () => {
          effects.push("ready");
          return ready;
        },
        manifest: async () => manifest,
        transport: async (url) =>
          new Response(url.includes("/cli/") ? "cli" : url.includes("/supervisor/") ? "supervisor" : "<head></head>B"),
        dashboard: async () => effects.push("dashboard"),
        migrate: async () => effects.push("migrations"),
        api: async () => effects.push("API"),
        active: async () => "a".repeat(40),
        receipt: async () => effects.push("activated"),
        clock: { now: () => 1000, sleep: async () => assert.fail("matching evidence cannot wait") },
      });
      assert.deepEqual(effects, ["ready", "dashboard", "ready", "migrations", "ready", "API", "activated"]);
    },
  );

  await t.test("stale infra and missing publication fail before mutations, including retries", async () => {
    for (const failure of ["infra", "prepared", "lease"]) {
      for (let retry = 0; retry < 2; retry += 1) {
        const writes = [];
        await assert.rejects(
          activateCandidate(candidate, {
            pins: candidate.pins,
            handoff: async () => ({ infra_fingerprint: failure === "infra" ? "e".repeat(40) : candidate.pins.infra }),
            lease: async () => ({ candidateId: failure === "lease" ? "0".repeat(64) : candidate.candidateId }),
            prepared: async () => ({ candidateId: "0".repeat(64) }),
            dashboard: async () => writes.push("dashboard"),
            migrate: async () => writes.push("migrations"),
            api: async () => writes.push("API"),
          }),
          /Pins or infra|not published|Another candidate/,
        );
        assert.deepEqual(writes, []);
      }
    }
  });

  await t.test("served dashboard bytes must match the tarball after origin injection", async () => {
    await verifyDashboard(
      candidate,
      async () => new Response('<head><meta name="tumpel-api-origin" content="https://api.dev.tumpel.dev"></head>B'),
    );
    await assert.rejects(
      verifyDashboard(candidate, async () => new Response("dashboard A")),
      /differs from its tarball/,
    );
  });
});

test("exact checks stop after ten observations; terminal failures never retry or accept older green commits", async () => {
  for (const outcome of ["pending", "failure", "auth"]) {
    let observations = 0;
    let now = 1000;
    const sleeps = [];
    await assert.rejects(
      exactChecks(
        "tumpel/control-plane",
        "a".repeat(40),
        async () => {
          observations += 1;
          if (outcome === "auth") throw new Error("GitHub 403");
          return {
            workflow_runs: [
              {
                id: 2,
                head_sha: "a".repeat(40),
                head_branch: "main",
                event: "push",
                status: outcome === "pending" ? "in_progress" : "completed",
                conclusion: "failure",
              },
              {
                id: 1,
                head_sha: "e".repeat(40),
                head_branch: "main",
                event: "push",
                status: "completed",
                conclusion: "success",
              },
            ],
          };
        },
        {
          now: () => now,
          sleep: async (delay) => {
            sleeps.push(delay);
            now += delay;
          },
        },
      ),
      outcome === "auth" ? /403/ : outcome === "failure" ? /Checks failed/ : /10 observations/,
    );
    assert.equal(observations, outcome === "pending" ? 10 : 1);
    assert.deepEqual(
      sleeps,
      outcome === "pending" ? [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000] : [],
    );
  }
});

test("candidate assembly accepts dashboard 0.9.0 and pages 0.7.0 as independent releases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "candidate-source-"));
  try {
    mkdirSync(join(dir, "package", "dist"), { recursive: true });
    writeFileSync(join(dir, "package", "dist", "index.html"), "dashboard 0.9.0");
    execFileSync("tar", ["-czf", join(dir, "dashboard.tgz"), "package"], { cwd: dir });
    const tarball = readFileSync(join(dir, "dashboard.tgz"));
    const candidate = await candidateSource({
      pins: { controlPlane: "a".repeat(40), infra: "b".repeat(40), cli: "1.0.0", supervisor: "1.0.0" },
      stage: "dev",
      clock: { now: () => 1000 },
      github: async (path) => {
        if (path.includes("/contents/")) {
          const value = path.includes("Cargo.lock")
            ? '[[package]]\nname = "tumpel-api"\nversion = "1.0.0"'
            : JSON.stringify({
                dependencies: {
                  "@tumpel/schemas": "https://github.com/tumpel/protocol/releases/download/v1.0.0/schemas.tgz",
                  "@tumpel/pages": "https://github.com/tumpel/dashboard/releases/download/v0.7.0/pages.tgz",
                  "@tumpel/dashboard": "https://github.com/tumpel/dashboard/releases/download/v0.9.0/dashboard.tgz",
                },
              });
          return { content: Buffer.from(value).toString("base64") };
        }
        if (path.includes("/releases/tags/"))
          return { draft: false, tag_name: path.includes("/dashboard/") ? "v0.9.0" : "v1.0.0" };
        if (path.includes("/commits/")) return { sha: "c".repeat(40) };
        assert.fail(`Unexpected GitHub read ${path}`);
      },
      transport: async (url) =>
        new Response(
          url.endsWith("dashboard.tgz")
            ? tarball
            : url.endsWith("dashboard.tgz.sha256")
              ? hash(tarball)
              : hash("binary"),
        ),
    });
    assert.equal(candidate.dashboard.version, "0.9.0");
    assert.deepEqual(candidate.dashboard.files, [{ path: "index.html", sha256: hash("dashboard 0.9.0") }]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
