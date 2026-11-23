import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transform } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { assembleCandidate } from "./assemble-rc.mjs";
import { candidateSource } from "./candidate-source.mjs";
import {
  activateCandidate,
  checkedCandidate,
  exactChecks,
  freezeCandidate,
  hash,
  publishCandidate,
  readyClients,
} from "./rollout.mjs";

const SOURCE = {
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
    version: "1.0.0",
    sha: "f".repeat(40),
    url: "https://github.com/tumpel/dashboard/releases/download/v1.0.0/dashboard.tgz",
    sha256: hash("tarball"),
    files: [{ path: "index.html", sha256: hash("<html><head></head><body>B</body></html>") }],
  },
};

test("dashboard A on dev becomes packed B only after publication, pin advancement and verified client-first activation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rollout-test-"));
  mkdirSync(join(dir, "package", "dist"), { recursive: true });
  const a = "<html><head></head><body>A</body></html>";
  const b = "<html><head></head><body>B</body></html>";
  writeFileSync(join(dir, "package", "dist", "index.html"), b);
  execFileSync("tar", ["-czf", join(dir, "dashboard.tgz"), "package"], { cwd: dir });
  const tarball = readFileSync(join(dir, "dashboard.tgz"));
  const candidate = await candidateSource({
    pins: SOURCE.pins,
    stage: "dev",
    clock: { now: () => 1000 },
    github: async (path) => {
      const source = (value) => ({
        content: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64"),
      });
      if (path.includes("packages/control-plane/package.json"))
        return source({
          dependencies: {
            "@tumpel/schemas": "https://github.com/tumpel/protocol/releases/download/v1.0.0-rc.4/schemas.tgz",
            "@tumpel/pages": "https://github.com/tumpel/dashboard/releases/download/v1.0.0/pages.tgz",
          },
        });
      if (path.includes("packages/dashboard-site/package.json"))
        return source({ dependencies: { "@tumpel/dashboard": SOURCE.dashboard.url } });
      if (path.includes("/dashboard/releases/tags/")) return { draft: false, tag_name: "v1.0.0" };
      if (path.includes("/dashboard/commits/")) return { sha: SOURCE.dashboard.sha };
      const name = path.includes("/cli/") ? "cli" : "supervisor";
      if (path.includes("/releases/tags/")) return { draft: false, tag_name: `v${SOURCE.pins[name]}` };
      if (path.includes("/commits/")) return { sha: SOURCE.clients[name].sha };
      if (path.includes("/contents/Cargo.lock"))
        return source('[[package]]\nname = "tumpel-api"\nversion = "1.0.0-rc.4"');
      assert.fail(`unexpected GitHub read ${path}`);
    },
    transport: async (url) => {
      if (url === SOURCE.dashboard.url) return new Response(tarball);
      if (url === `${SOURCE.dashboard.url}.sha256`) return new Response(hash(tarball));
      if (url.endsWith(".sha256")) return new Response(hash(url.includes("/cli/") ? "cli" : "supervisor"));
      assert.fail(`unexpected release download ${url}`);
    },
  });
  const manifest = {
    releaseVersion: "v1.0.0-rc.1",
    clis: [{ cliVersion: SOURCE.pins.cli, ...SOURCE.clients.cli.binaries[0] }],
    supervisors: [{ supervisorVersion: SOURCE.pins.supervisor, ...SOURCE.clients.supervisor.binaries[0] }],
  };
  let served = a;
  let activeCommit = "0".repeat(40);
  let current = {
    releaseVersion: "old",
    clis: [{ cliVersion: "0.9.0" }],
    supervisors: [{ supervisorVersion: "0.9.0" }],
  };
  const events = [];
  const objects = new Map();
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-10-01",
      script: (
        await transform(readFileSync(new URL("fixtures/dashboard-worker.ts", import.meta.url), "utf8"), {
          loader: "ts",
          format: "esm",
        })
      ).code,
      bindings: { API_ORIGIN: "https://api.dev.tumpel.dev" },
      serviceBindings: { ASSETS: () => new Response(served, { headers: { "content-type": "text/html" } }) },
    }),
  );
  const clock = { now: () => 1000, sleep: async () => assert.fail("all readiness observations are ready") };
  const github = async (path) => ({
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
  });
  const stageTransport = async (url) => {
    if (url.includes("/v1/releases/cli/")) {
      events.push("CLI live");
      return new Response("cli");
    }
    if (url.includes("/v1/releases/supervisor/")) {
      events.push("supervisor live");
      return new Response("supervisor");
    }
    return worker.dispatchFetch(url);
  };
  const readiness = async () => ({
    candidateId: candidate.candidateId,
    scope: "TumpelRun",
    inventoryComplete: true,
    stage: "dev",
    observedAt: 1000,
    status: "Ready",
    supervisors: [{ hostId: "stage-host", online: true, supervisorVersion: SOURCE.pins.supervisor }],
    consumers: [
      {
        repository: "tumpel/cli",
        kind: "Cli",
        sha: SOURCE.clients.cli.sha,
        protocol: SOURCE.protocol,
        status: "Ready",
      },
      {
        repository: "tumpel/supervisor",
        kind: "Supervisor",
        sha: SOURCE.clients.supervisor.sha,
        protocol: SOURCE.protocol,
        status: "Ready",
      },
      {
        repository: "tumpel/control-plane",
        kind: "Mcp",
        sha: SOURCE.pins.controlPlane,
        protocol: SOURCE.protocol,
        status: "Ready",
      },
    ],
  });
  try {
    assert.match(await (await worker.dispatchFetch("https://dev.tumpel.dev/")).text(), /<body>A/);
    await assembleCandidate(candidate, {
      tag: async () => {
        events.push("freeze-tag");
        return "e".repeat(40);
      },
      publish: () =>
        publishCandidate(candidate, manifest, {
          get: async (key) => (objects.has(key) ? { value: objects.get(key), etag: '"etag"' } : undefined),
          put: async (key, value, conditions) => {
            if (key === "rollout.json") assert.deepEqual(conditions, { "if-none-match": "*" });
            events.push(key);
            objects.set(key, value);
            if (key === "current.json") current = value;
          },
          github,
          transport: stageTransport,
          readiness,
          endpoint: async () => {
            events.push("manifest-read-back");
            return current;
          },
          clock,
        }),
      observe: async (sha) => ({
        workflow_runs: [
          { id: 1, head_sha: sha, event: "workflow_dispatch", status: "completed", conclusion: "success" },
        ],
      }),
      readBack: async () => current,
      advance: async () => {
        events.push("advance-pins");
      },
    });
    const dashboard = async () => {
      events.push("dashboard");
      served = b;
    };

    await activateCandidate(candidate, {
      pins: candidate.pins,
      handoff: async () => ({ infra_fingerprint: candidate.pins.infra }),
      lease: async () => objects.get("rollout.json"),
      prepared: async () => objects.get(`prepared/${candidate.candidateId}.json`),
      github,
      transport: stageTransport,
      readiness,
      manifest: async () => current,
      dashboard,
      migrate: async () => {
        events.push("D1 migrations");
      },
      api: async () => {
        events.push("API Worker");
        activeCommit = candidate.pins.controlPlane;
      },
      active: async () => {
        events.push("Worker read-back");
        return activeCommit;
      },
      receipt: async (value) => {
        events.push("activated");
        objects.set(`activated/${candidate.candidateId}.json`, value);
      },
      clock,
    });
    assert.match(await (await worker.dispatchFetch("https://dev.tumpel.dev/")).text(), /<body>B/);
    for (const [before, after] of [
      ["current.json", "advance-pins"],
      ["manifest-read-back", "advance-pins"],
      ["CLI live", "advance-pins"],
      ["supervisor live", "advance-pins"],
      ["advance-pins", "dashboard"],
      ["dashboard", "D1 migrations"],
      ["D1 migrations", "API Worker"],
      ["API Worker", "Worker read-back"],
      ["Worker read-back", "activated"],
    ])
      assert.ok(events.indexOf(before) < events.indexOf(after), `${before} must precede ${after}`);
  } finally {
    await worker.dispose();
    rmSync(dir, { recursive: true });
  }
});

test("failed publication and failed exact-SHA checks preserve dashboard A, old manifest and pins", async () => {
  const candidate = freezeCandidate(SOURCE);
  for (const failure of ["release", "checks"]) {
    let current = "old manifest";
    let advanced = false;
    const served = "A";
    await assert.rejects(
      assembleCandidate(candidate, {
        tag: async () => undefined,
        publish: () =>
          publishCandidate(
            candidate,
            {
              clis: [{ cliVersion: candidate.pins.cli, ...candidate.clients.cli.binaries[0] }],
              supervisors: [
                { supervisorVersion: candidate.pins.supervisor, ...candidate.clients.supervisor.binaries[0] },
              ],
            },
            {
              get: async () => undefined,
              put: async (key) => {
                if (key === "current.json") throw new Error("release failed");
              },
              github: async (path) => ({
                workflow_runs: [
                  {
                    id: 2,
                    head_sha: new URL(`https://api.github.com${path}`).searchParams.get("head_sha"),
                    head_branch: "main",
                    event: "push",
                    status: "completed",
                    conclusion: failure === "checks" ? "failure" : "success",
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
              }),
              endpoint: async () => current,
            },
          ),
        readBack: async () => current,
        advance: async () => {
          advanced = true;
          current = "new manifest";
        },
      }),
      failure === "checks" ? /Checks failed/ : /release failed/,
    );
    assert.equal(served, "A");
    assert.equal(current, "old manifest");
    assert.equal(advanced, false);
  }
});

test("premature activation, stale infra and overlapping candidates cannot mutate the API", async () => {
  const candidate = freezeCandidate(SOURCE);
  for (const refusal of ["premature", "infra", "overlap", "pins"]) {
    const writes = [];
    await assert.rejects(
      activateCandidate(candidate, {
        pins: refusal === "pins" ? { ...candidate.pins, cli: "9.0.0" } : candidate.pins,
        handoff: async () => ({ infra_fingerprint: refusal === "infra" ? "f".repeat(40) : candidate.pins.infra }),
        lease: async () => ({ candidateId: refusal === "overlap" ? "0".repeat(64) : candidate.candidateId }),
        prepared: async () => ({ candidateId: "0".repeat(64) }),
        github: async () => assert.fail("premature activation cannot reach checks"),
        dashboard: async () => writes.push("dashboard"),
        migrate: async () => writes.push("D1"),
        api: async () => writes.push("API"),
      }),
      /Pins or infra|Another candidate|not published/,
    );
    assert.deepEqual(writes, []);
  }
});

test("every online supervisor must update, with nine fake sleeps and failure on observation ten", async () => {
  const candidate = freezeCandidate(SOURCE);
  const sleeps = [];
  let now = 1000;
  let observations = 0;
  await assert.rejects(
    activateCandidate(candidate, {
      pins: candidate.pins,
      handoff: async () => ({ infra_fingerprint: candidate.pins.infra }),
      lease: async () => ({ candidateId: candidate.candidateId }),
      prepared: async () => ({ candidateId: candidate.candidateId, manifest: {} }),
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
      dashboard: async () => assert.fail("old supervisors block dashboard deployment"),
      migrate: async () => assert.fail("old supervisors block migrations"),
      api: async () => assert.fail("old supervisors block API activation"),
      clock: {
        now: () => now,
        sleep: async (delay) => {
          sleeps.push(delay);
          now += delay;
        },
      },
      readiness: async () => {
        observations += 1;
        return {
          candidateId: candidate.candidateId,
          scope: "TumpelRun",
          inventoryComplete: true,
          stage: "dev",
          observedAt: now,
          status: "Ready",
          supervisors: [
            { hostId: "ready", online: true, supervisorVersion: candidate.pins.supervisor },
            { hostId: "old", online: true, supervisorVersion: "0.9.0" },
          ],
          consumers: [
            {
              repository: "tumpel/cli",
              kind: "Cli",
              sha: candidate.clients.cli.sha,
              protocol: candidate.protocol,
              status: "Ready",
            },
            {
              repository: "tumpel/supervisor",
              kind: "Supervisor",
              sha: candidate.clients.supervisor.sha,
              protocol: candidate.protocol,
              status: "Ready",
            },
            {
              repository: "tumpel/control-plane",
              kind: "Mcp",
              sha: candidate.pins.controlPlane,
              protocol: candidate.protocol,
              status: "Ready",
            },
          ],
        };
      },
      manifest: async () => assert.fail("old supervisors must block manifest acceptance"),
    }),
    /timed out after 10 observations/,
  );
  assert.equal(observations, 10);
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000]);
  assert.equal(now, 512000);
});

test("auth errors and failed checks stop immediately, and an older green commit cannot substitute", async () => {
  for (const mode of ["auth", "failed"]) {
    let observations = 0;
    await assert.rejects(
      exactChecks(
        "tumpel/control-plane",
        "a".repeat(40),
        async () => {
          observations += 1;
          if (mode === "auth") throw new Error("GitHub 401");
          return {
            workflow_runs: [
              {
                id: 2,
                head_sha: "a".repeat(40),
                head_branch: "main",
                event: "push",
                status: "completed",
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
        { sleep: async () => assert.fail("terminal failures must not sleep") },
      ),
      mode === "auth" ? /401/ : /Checks failed/,
    );
    assert.equal(observations, 1);
  }
});

test("frozen candidates reject changed pins and clients built for a different protocol", () => {
  const candidate = freezeCandidate(SOURCE);
  assert.throws(
    () => checkedCandidate({ ...candidate, pins: { ...candidate.pins, cli: "9.0.0" } }),
    /changed after freezing/,
  );
  assert.throws(
    () =>
      checkedCandidate(
        freezeCandidate({
          ...SOURCE,
          clients: { ...SOURCE.clients, cli: { ...SOURCE.clients.cli, protocol: "9.0.0" } },
        }),
      ),
    /candidate protocol/,
  );
});

test("missing, stale, external and failed client evidence aborts without sleeping", async () => {
  const candidate = freezeCandidate(SOURCE);
  for (const evidence of [
    undefined,
    {
      candidateId: candidate.candidateId,
      scope: "External",
      inventoryComplete: true,
      stage: "dev",
      observedAt: 1000,
      status: "Ready",
      supervisors: [],
      consumers: [],
    },
    {
      candidateId: candidate.candidateId,
      scope: "TumpelRun",
      inventoryComplete: true,
      stage: "dev",
      observedAt: 1000,
      status: "Ready",
      supervisors: [],
      consumers: [],
    },
    {
      candidateId: candidate.candidateId,
      scope: "TumpelRun",
      inventoryComplete: true,
      stage: "dev",
      observedAt: 100000,
      status: "Failed",
      supervisors: [],
      consumers: [],
    },
  ]) {
    await assert.rejects(
      readyClients(candidate, {
        read: async () => evidence,
        clock: { now: () => 100000, sleep: async () => assert.fail("invalid evidence must not sleep") },
        manifest: async () => assert.fail("invalid evidence must not reach activation"),
      }),
    );
  }
});

test("an active candidate excludes the next publisher until Worker activation", async () => {
  const candidate = freezeCandidate(SOURCE);
  const writes = [];
  await assert.rejects(
    publishCandidate(
      candidate,
      {
        clis: [{ cliVersion: candidate.pins.cli, ...candidate.clients.cli.binaries[0] }],
        supervisors: [{ supervisorVersion: candidate.pins.supervisor, ...candidate.clients.supervisor.binaries[0] }],
      },
      {
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
        get: async (key) =>
          key === "rollout.json" ? { value: { candidateId: "0".repeat(64) }, etag: '"previous"' } : undefined,
        put: async (key) => {
          writes.push(key);
        },
      },
    ),
    /Another candidate owns this stage/,
  );
  assert.deepEqual(writes, []);
});

test("dashboard deployment failure and wrong served bytes block migrations and the API", async () => {
  const candidate = freezeCandidate(SOURCE);
  const manifest = {
    clis: [{ cliVersion: candidate.pins.cli, ...candidate.clients.cli.binaries[0] }],
    supervisors: [{ supervisorVersion: candidate.pins.supervisor, ...candidate.clients.supervisor.binaries[0] }],
  };
  for (const failure of ["deployment", "bytes"]) {
    const writes = [];
    const dashboard = async () => {
      if (failure === "deployment") throw new Error("dashboard deploy failed");
    };

    await assert.rejects(
      activateCandidate(candidate, {
        pins: candidate.pins,
        handoff: async () => ({ infra_fingerprint: candidate.pins.infra }),
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
        transport: async (url) =>
          new Response(
            url.includes("/v1/releases/cli/")
              ? "cli"
              : url.includes("/v1/releases/supervisor/")
                ? "supervisor"
                : "dashboard A is still served",
          ),
        readiness: async () => ({
          candidateId: candidate.candidateId,
          scope: "TumpelRun",
          inventoryComplete: true,
          stage: "dev",
          observedAt: 1000,
          status: "Ready",
          supervisors: [],
          consumers: [
            {
              repository: "tumpel/cli",
              kind: "Cli",
              sha: candidate.clients.cli.sha,
              protocol: candidate.protocol,
              status: "Ready",
            },
            {
              repository: "tumpel/supervisor",
              kind: "Supervisor",
              sha: candidate.clients.supervisor.sha,
              protocol: candidate.protocol,
              status: "Ready",
            },
            {
              repository: "tumpel/control-plane",
              kind: "Mcp",
              sha: candidate.pins.controlPlane,
              protocol: candidate.protocol,
              status: "Ready",
            },
          ],
        }),
        manifest: async () => manifest,
        dashboard,
        migrate: async () => {
          writes.push("D1");
        },
        api: async () => {
          writes.push("API");
        },
        clock: { now: () => 1000, sleep: async () => assert.fail("ready evidence must not sleep") },
      }),
      failure === "deployment" ? /dashboard deploy failed/ : /differs from its tarball/,
    );
    assert.deepEqual(writes, []);
  }
});

test("publication observes exactly ten times with a fake clock before refusing pin advancement", async () => {
  const candidate = freezeCandidate(SOURCE);
  const sleeps = [];
  let observations = 0;
  await assert.rejects(
    assembleCandidate(candidate, {
      tag: async () => "e".repeat(40),
      publish: async () => undefined,
      observe: async (sha) => {
        observations += 1;
        return {
          workflow_runs: [
            { id: 1, head_sha: sha, event: "workflow_dispatch", status: "in_progress", conclusion: null },
          ],
        };
      },
      readBack: async () => assert.fail("pending publication cannot authorize read-back"),
      advance: async () => assert.fail("pending publication cannot advance pins"),
      clock: {
        sleep: async (delay) => {
          sleeps.push(delay);
        },
      },
    }),
    /Publication timed out after 10 observations/,
  );
  assert.equal(observations, 10);
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000]);
});
