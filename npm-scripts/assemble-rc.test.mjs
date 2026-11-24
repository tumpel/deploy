import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkedCandidate, hash } from "./rollout.mjs";
import { scenario, write } from "./test-support/release-scenario/workspace.mjs";

test("dispatch tags the assembled candidate and manual assembly tags pins alone", async (t) => {
  const { dir, cloud, git, run, node, repo, commit, clients, deployRepo } = await scenario(t);
  const dashboard = repo("dashboard");
  write(join(dashboard, "package.json"), { name: "dashboard", version: "1.0.0", files: ["dist"] });
  write(join(dashboard, "dist/index.html"), "<head></head>");
  const dashboardSha = commit(dashboard, "feat: ship dashboard");
  git(dashboard, "push", "-q", "origin", "main", "HEAD:refs/tags/v1.0.0");
  const { stdout } = await run(dashboard, "npm", ["pack", "--json"]);
  const tarball = readFileSync(join(dashboard, JSON.parse(stdout)[0].filename));
  const release = cloud.publish("dashboard", "v1.0.0", [
    ["dashboard.tgz", tarball],
    ["dashboard.tgz.sha256", hash(tarball)],
  ]);
  clients("1.0.0");
  const cp = repo("control-plane"),
    infra = repo("infra");
  const old = commit(cp, "chore: start control plane");
  write(join(cp, "packages/control-plane/package.json"), {
    dependencies: { "@tumpel/schemas": "https://github.com/tumpel/protocol/releases/download/v1.0.0/schemas.tgz" },
  });
  write(join(cp, "packages/dashboard-site/package.json"), {
    dependencies: { "@tumpel/dashboard": release.assets[0].url },
  });
  const next = commit(cp, "fix: update control plane");
  const infraSha = commit(infra, "chore: start infra");
  for (const cwd of [cp, infra]) git(cwd, "push", "-q", "origin", "main");
  cloud.check("control-plane", next, "success");
  cloud.check("infra", infraSha, "success");
  const original = { controlPlane: old, infra: infraSha, cli: "1.0.0", supervisor: "1.0.0" };
  const checkout = deployRepo(original);
  const origin = `${checkout}.git`,
    rc = "v1.0.1-rc.1";
  const event = join(dir, "event.json");
  write(event, { client_payload: { candidateId: "untrusted" } });
  const assemble = (name) =>
    node(checkout, "assemble-rc", [], {
      GITHUB_REPOSITORY: "tumpel/deploy",
      GITHUB_EVENT_NAME: name,
      GITHUB_EVENT_PATH: event,
    });
  await assemble("repository_dispatch");
  const candidate = checkedCandidate(JSON.parse(git(origin, "show", `${rc}:release-candidate.json`)));
  assert.deepEqual(candidate.pins, { ...original, controlPlane: next });
  assert.deepEqual(candidate.pins, JSON.parse(git(origin, "show", `${rc}:release-pins.json`)));
  assert.equal(candidate.dashboard.sha, dashboardSha);
  assert.equal(git(origin, "rev-parse", "main"), git(origin, "rev-parse", "v1.0.0"));
  assert.equal(git(origin, "diff", "--name-only", "main", rc), "release-candidate.json\nrelease-pins.json");
  git(checkout, "switch", "-q", "main");
  await assemble("workflow_dispatch");
  const manual = "v1.0.1-rc.2";
  assert.equal(git(origin, "rev-parse", "main"), git(origin, "rev-parse", manual));
  assert.equal(git(origin, "diff", "--name-only", "v1.0.0", manual), "release-pins.json");
});
