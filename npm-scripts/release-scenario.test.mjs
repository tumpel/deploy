import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dashboardFiles } from "./candidate-source.mjs";
import { freezeCandidate, hash } from "./rollout.mjs";
import { scenarioServices } from "./test-support/release-scenario/services.mjs";
import { scenarioSources } from "./test-support/release-scenario/sources.mjs";
import {
  controlPlaneCheckout,
  dashboardCheckout,
  deployCheckout,
  readJson,
  workspace,
  write,
  writeJson,
} from "./test-support/release-scenario/workspace.mjs";

test("a dashboard candidate stops before Workers activation on a release, checks or evidence failure", {
  timeout: 120_000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "release-scenario-"));
  const sourceDir = join(dir, "sources");
  mkdirSync(sourceDir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sources = await scenarioSources(sourceDir);
  const services = await scenarioServices(t);
  const fixture = workspace(dir, services, sources);
  const { git, commit, scripts, deployScript } = fixture;

  const bytesA = Buffer.from('export const release = "dashboard A";\n');
  const bytesB = Buffer.from('export const release = "dashboard B";\n');
  const dashboard = await dashboardCheckout(fixture, sources.dashboard, services, bytesA);
  const controlPlane = await controlPlaneCheckout(fixture, sources.controlPlane, dashboard.version, services);
  const infra = fixture.repository("infra");
  write(join(infra.worktree, "README.md"), "Dev infrastructure\n");
  const infraSha = commit(infra.worktree, "chore: pin dev infrastructure");
  git(infra.worktree, "push", "--quiet", "origin", "main");
  services.check("tumpel/infra", infraSha, "success");
  const pins = { controlPlane: controlPlane.sha, infra: infraSha, cli: "1.0.0", supervisor: "1.0.0" };
  const deploy = deployCheckout(fixture, pins);

  const d1 = "10000000-0000-0000-0000-000000000001";
  const { publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  services.objects.set("tumpel-builder-secrets/infra-outputs-dev.json", {
    body: JSON.stringify({
      infra_fingerprint: pins.infra,
      d1_database_id: d1,
      hostname: "api.dev.tumpel.dev",
      dashboard_hostname: "dev.tumpel.dev",
      vapid_public_key: publicKey,
    }),
  });
  const manifestKey = "tumpel-releases-dev/current.json";
  const manifestA = JSON.stringify({ commit: deploy.sha, releaseVersion: "v1.0.0" });
  services.objects.set(manifestKey, { body: manifestA, etag: '"release-a"' });
  await deployScript(deploy.worktree, "deploy", [d1]);
  const activationsA = ["dashboard", "migrations", "execute", "api"];
  const assertA = async () => {
    const response = await services.dashboard("/release.js");
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytesA);
    assert.equal(services.objects.get(manifestKey).body, manifestA);
    assert.equal(git(deploy.remote, "rev-parse", "main"), deploy.sha);
    assert.deepEqual(readJson(join(deploy.worktree, "release-pins.json")), pins);
    assert.equal(git(deploy.remote, "tag", "--list"), "v1.0.0");
    assert.deepEqual(services.operations, activationsA);
  };
  await assertA();

  git(dashboard.worktree, "switch", "--quiet", "-c", "dashboard-b");
  write(dashboard.sourceAsset, bytesB);
  commit(dashboard.worktree, "fix: update the dashboard asset");
  git(dashboard.worktree, "switch", "--quiet", "main");
  git(dashboard.worktree, "merge", "--quiet", "--squash", "dashboard-b");
  const shaB = commit(dashboard.worktree, "fix: ship dashboard B");
  git(dashboard.worktree, "push", "--quiet", "origin", "main");
  const { stdout } = await scripts(dashboard.worktree, [
    "--input-type=module",
    "--eval",
    'import { candidatePlan, releaseSource } from "./npm-scripts/release-plan.mjs"; console.log(JSON.stringify(candidatePlan(releaseSource(process.cwd()))));',
  ]);
  const plan = JSON.parse(stdout);
  assert.deepEqual(plan, { tag: "v0.10.1-rc.1", version: "0.10.1-rc.1" });

  const release = () =>
    scripts(dashboard.worktree, ["npm-scripts/release.mjs"], {
      GITHUB_REPOSITORY: "tumpel/dashboard",
      GITHUB_REF_TYPE: "branch",
      CONTROL_PLANE_DISPATCH_TOKEN: "test-value",
    });
  services.check("tumpel/dashboard", shaB, "success");
  await t.test("failed dashboard release leaves A live", async () => {
    services.failures.release = plan.tag;
    await assert.rejects(release(), (error) => {
      assert.match(error.stderr, /GitHub release creation returned 503/);
      return true;
    });
    assert.equal(services.releases.has(`tumpel/dashboard/${plan.tag}`), false);
    assert.deepEqual(services.dispatches, []);
    await assertA();
    services.failures.release = undefined;
  });

  await release();
  const [dispatch] = services.dispatches;
  assert.equal(dispatch.repository, "tumpel/control-plane");
  assert.equal(dispatch.event.client_payload.sha, shaB);
  assert.equal(dispatch.event.client_payload.tag, plan.tag);
  const dashboardEvent = join(dir, "dashboard-released.json");
  writeJson(dashboardEvent, dispatch.event);
  const updateDashboard = () =>
    scripts(controlPlane.worktree, ["npm-scripts/update-dashboard.mjs"], {
      GITHUB_EVENT_PATH: dashboardEvent,
      CONTROL_PLANE_UPDATE_TOKEN: "test-value",
    });

  await t.test("failed checks on dashboard B leave A live despite a green A", async () => {
    services.check("tumpel/dashboard", shaB, "failure");
    await assert.rejects(updateDashboard(), (error) => {
      assert.match(error.stderr, new RegExp(`Checks for tumpel/dashboard@${shaB} have not completed successfully`));
      return true;
    });
    assert.equal(git(controlPlane.remote, "rev-parse", "main"), controlPlane.sha);
    assert.deepEqual(services.pulls, []);
    assert.equal(services.dispatches.length, 1);
    await assertA();
  });

  services.check("tumpel/dashboard", shaB, "success");
  await updateDashboard();
  const [pull] = services.pulls;
  assert.deepEqual(pull.auto_merge, { merge_method: "squash" });
  git(controlPlane.worktree, "switch", "--quiet", pull.base);
  git(controlPlane.worktree, "merge", "--quiet", "--squash", pull.head);
  const controlPlaneB = commit(controlPlane.worktree, pull.title);
  git(controlPlane.worktree, "push", "--quiet", "origin", pull.base);
  pull.state = "closed";
  const lock = readJson(join(controlPlane.worktree, "package-lock.json"));
  for (const name of ["dashboard", "pages"]) {
    const url = `https://github.com/tumpel/dashboard/releases/download/${plan.tag}/${name}-${plan.version}.tgz`;
    assert.equal(lock.packages[`node_modules/@tumpel/${name}`].resolved, url);
  }

  services.check("tumpel/control-plane", controlPlaneB, "success");
  const checksEvent = join(dir, "control-plane-checks.json");
  writeJson(checksEvent, {
    workflow_run: {
      name: "checks",
      event: "push",
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      head_sha: controlPlaneB,
    },
  });
  await scripts(controlPlane.worktree, ["npm-scripts/dispatch-deploy.mjs"], {
    DEPLOY_DISPATCH_TOKEN: "test-value",
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_EVENT_PATH: checksEvent,
  });
  const deployDispatch = services.dispatches.at(-1);
  assert.equal(deployDispatch.repository, "tumpel/deploy");
  assert.equal(deployDispatch.event.client_payload.sha, controlPlaneB);
  const deployEvent = join(dir, "control-plane-released.json");
  writeJson(deployEvent, deployDispatch.event);
  const assemble = () =>
    deployScript(deploy.worktree, "assemble-rc", [], {
      GITHUB_EVENT_NAME: "repository_dispatch",
      GITHUB_EVENT_PATH: deployEvent,
    });

  await t.test("missing client evidence leaves A live after the real dependency PR merges", async () => {
    const requests = services.requests.length;
    await assert.rejects(assemble(), (error) => {
      assert.match(error.stderr, /Candidate client readiness evidence is missing/);
      return true;
    });
    assert.equal(services.requests.length, requests);
    assert.equal(services.dispatches.length, 2);
    await assertA();
  });

  await t.test("pending exact checks stop after ten subprocess observations and nine sleeps", async () => {
    for (const client of ["cli", "supervisor"]) services.publish(`tumpel/${client}`, "v1.0.0", {});
    const url = lock.packages["node_modules/@tumpel/dashboard"].resolved;
    const tarball = services.assets.get(url);
    const binary = [{ architecture: "Amd64", sha256: hash("binary") }];
    writeJson(
      join(deploy.worktree, "release-candidate.json"),
      freezeCandidate({
        createdAt: fixture.now,
        stage: "dev",
        pins: { ...pins, controlPlane: controlPlaneB },
        protocol: "1.0.0",
        clients: {
          cli: { version: pins.cli, sha: "c".repeat(40), protocol: "1.0.0", binaries: binary },
          supervisor: { version: pins.supervisor, sha: "d".repeat(40), protocol: "1.0.0", binaries: binary },
        },
        dashboard: {
          version: plan.version,
          sha: shaB,
          url,
          sha256: hash(tarball),
          files: dashboardFiles(tarball),
        },
      }),
    );
    const before = services.requests.length;
    services.check("tumpel/control-plane", controlPlaneB, "pending");
    await assert.rejects(assemble(), (error) => {
      assert.match(error.stderr, /Checks timed out after 10 observations for tumpel\/control-plane/);
      return true;
    });
    const observations = services.requests
      .slice(before)
      .filter(
        ({ url }) =>
          url.pathname === "/repos/tumpel/control-plane/actions/workflows/checks.yml/runs" &&
          url.searchParams.get("head_sha") === controlPlaneB,
      );
    assert.equal(observations.length, 10);
    assert.deepEqual(
      readFileSync(fixture.sleeps, "utf8").trim().split("\n").map(Number),
      [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000],
    );
    await assertA();
  });
});
