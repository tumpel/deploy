import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GuestProtocol } from "@tumpel/schemas";
import { checkedCandidate, hash } from "./rollout.mjs";
import { download, read, root, scenario, unpack, upstream, write } from "./test-support/release-scenario/workspace.mjs";

test("checked dashboard bytes reach dev after readiness", { timeout: 180_000 }, async (t) => {
  const { dir, env, cloud, git, run, node, repo, commit, clients, deployRepo } = await scenario(t);
  const [dashboardSource, controlSource, convco] = await Promise.all([
    upstream(dir, "dashboard", "c3ed5026a9d5c32c84d9344517ef0b5ecf54751d"),
    upstream(dir, "control-plane", "f2bd4490b649aa9962921672ac10e615f29e8f52"),
    download("https://github.com/convco/convco/releases/download/v0.7.2/convco-x86_64-unknown-linux-musl.tar.gz"),
  ]);
  assert.equal(hash(convco), "f9cfad24af372018f4b8d430cf86d1b7b9b36fcb7e1db5dd30c54b2eed7dde75");
  unpack(dir, convco, "convco-x86_64-unknown-linux-musl/convco");
  const dashboard = repo("dashboard"),
    cp = repo("control-plane"),
    infra = repo("infra");
  const copy = (from, to, path) => cpSync(join(from, path), join(to, path), { recursive: true });
  cpSync(dashboardSource, dashboard, { recursive: true });
  await run(dashboard, "npm", ["ci"], { NODE_OPTIONS: "" });
  const asset = join(dashboard, "packages/dashboard/public/release.js");
  const a = Buffer.from('export const release = "A";\n');
  const b = Buffer.from('export const release = "B";\n');
  write(asset, a);
  commit(dashboard, "feat: start dashboard");
  git(dashboard, "push", "-q", "origin", "main");
  const output = join(dir, "output"),
    repoEnv = { GITHUB_REPOSITORY: "tumpel/dashboard", GITHUB_OUTPUT: output };
  await node(dashboard, "release", [], { ...repoEnv, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.10.0" });
  git(dashboard, "fetch", "-q", "--tags", "origin");

  const pkg = (cwd, name = "") => join(cwd, name, "package.json");
  const workspace = { private: true, type: "module", workspaces: ["packages/*"] };
  copy(controlSource, cp, "npm-scripts");
  copy(controlSource, cp, "packages/dashboard-site");
  const sourceLock = read(join(controlSource, "package-lock.json")).packages;
  const schemas = sourceLock["node_modules/@tumpel/schemas"],
    zod = sourceLock["node_modules/zod"];
  for (const { resolved } of [schemas, zod]) cloud.assets.set(resolved, await download(resolved));
  const protocol = schemas.version;
  clients(protocol);
  const releaseUrl = (name, version) =>
    `https://github.com/tumpel/dashboard/releases/download/v${version}/${name}-${version}.tgz`;
  write(pkg(cp), { ...workspace, name: "control-plane", dependencies: { wrangler: "1.0.0", zod: zod.resolved } });
  const apiPackage = "packages/control-plane",
    sitePackage = "packages/dashboard-site";
  const apiDeps = { "@tumpel/pages": releaseUrl("pages", "0.10.0"), "@tumpel/schemas": schemas.resolved };
  write(pkg(cp, apiPackage), { name: "@tumpel/control-plane", dependencies: apiDeps });
  const siteDeps = { "@tumpel/dashboard": releaseUrl("dashboard", "0.10.0") };
  write(pkg(cp, sitePackage), { name: "@tumpel/dashboard-site", dependencies: siteDeps });
  for (const file of ["presign", "harness-catalog", "compact", "guest-toolchains"])
    copy(controlSource, cp, `${apiPackage}/src/${file}.ts`);
  write(join(cp, apiPackage, "wrangler.jsonc"), {});
  const wrangler = { name: "wrangler", version: "1.0.0", type: "module", bin: "wrangler.mjs" };
  write(pkg(cp, "packages/wrangler"), wrangler);
  cpSync(join(root, "npm-scripts/test-support/release-scenario/edges.mjs"), join(cp, "packages/wrangler/wrangler.mjs"));
  await run(cp, "npm", ["install", "--package-lock-only", "--ignore-scripts"]);
  const cpA = commit(cp, "chore: pin dashboard A"),
    infraSha = commit(infra, "chore: set up dev");
  for (const cwd of [cp, infra]) git(cwd, "push", "-q", "origin", "main");
  cloud.check("control-plane", cpA, "success");
  cloud.check("infra", infraSha, "success");
  const pins = { controlPlane: cpA, infra: infraSha, cli: "1.0.0", supervisor: "1.0.0" };
  const deploy = deployRepo(pins),
    initial = git(deploy, "rev-parse", "HEAD");
  const deployEnv = { GITHUB_REPOSITORY: "tumpel/deploy" };
  const db = "10000000-0000-0000-0000-000000000001";
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const bucket = "tumpel-releases-dev";
  const put = (key, data) => cloud.objects.set(`${bucket}/${key}`, JSON.stringify(data));
  const handoff = {
    infra_fingerprint: infraSha,
    d1_database_id: db,
    hostname: "api.dev.tumpel.dev",
    dashboard_hostname: "dev.tumpel.dev",
    vapid_public_key: publicKey.export({ format: "pem", type: "spki" }),
  };
  cloud.objects.set("tumpel-builder-secrets/infra-outputs-dev.json", JSON.stringify(handoff));
  put("current.json", { commit: initial, releaseVersion: "v1.0.0" });
  await node(deploy, "deploy", [db], deployEnv);
  const current = () => cloud.objects.get(`${bucket}/current.json`).toString();
  const manifestA = current(),
    readBack = async () => Buffer.from(await (await cloud.serveDashboard("/release.js")).arrayBuffer());
  cloud.operations.length = 0;
  const assertA = async () => {
    assert.deepEqual([await readBack(), current(), git(`${deploy}.git`, "rev-parse", "main")], [a, manifestA, initial]);
    assert.deepEqual(cloud.operations, []);
  };

  git(dashboard, "switch", "-qc", "fix-b");
  write(asset, b);
  commit(dashboard, "fix: change the asset");
  git(dashboard, "switch", "-q", "main");
  git(dashboard, "merge", "-q", "--squash", "fix-b");
  const sha = commit(dashboard, "fix: ship dashboard B");
  git(dashboard, "push", "-q", "origin", "main");
  cloud.check("dashboard", sha, "success");
  const releaseEnv = { ...repoEnv, GITHUB_EVENT_NAME: "workflow_run", GITHUB_REF_TYPE: "branch" };
  const release = async () => {
    write(output, "");
    await node(dashboard, "release", [], releaseEnv);
    return readFileSync(output, "utf8").trim().split("=")[1];
  };
  const dispatch = (tag) =>
    node(dashboard, "dispatch", [tag], { ...repoEnv, RELEASE_SHA: sha, CONTROL_PLANE_DISPATCH_TOKEN: "fixture" });
  const unavailable = () => new Response(null, { status: 503 });
  const failRelease = "POST api.github.com/repos/tumpel/dashboard/releases";
  cloud.overrides.set(failRelease, unavailable);
  await assert.rejects(async () => dispatch(await release()), /returned 503/);
  assert.equal(cloud.dispatches.length, 0);
  await assertA();
  cloud.overrides.delete(failRelease);

  const tag = await release();
  assert.equal(tag, "v0.10.1-rc.1");
  const failDispatch = "POST api.github.com/repos/tumpel/control-plane/dispatches";
  let attempted;
  cloud.overrides.set(failDispatch, (body) => {
    attempted = JSON.parse(body);
    return unavailable();
  });
  await assert.rejects(dispatch(tag), /returned 503/);
  cloud.overrides.delete(failDispatch);
  await dispatch(tag);
  assert.deepEqual(cloud.dispatches, [attempted]);
  assert.equal([...cloud.releases.keys()].filter((key) => key === `dashboard/${tag}`).length, 1);
  const event = join(dir, "event.json");
  write(event, attempted);
  await node(cp, "update-dashboard", [], { GITHUB_EVENT_PATH: event, CONTROL_PLANE_UPDATE_TOKEN: "fixture" });
  const [pull] = cloud.pulls;
  assert.equal(pull.auto_merge.merge_method, "squash");
  git(cp, "switch", "-q", pull.base);
  git(cp, "merge", "-q", "--squash", pull.head);
  const cpB = commit(cp, pull.title);
  git(cp, "push", "-q", "origin", pull.base);
  const dispatchEnv = { GITHUB_EVENT_NAME: "repository_dispatch", GITHUB_REPOSITORY: "tumpel/deploy" };
  const assemble = () => node(deploy, "assemble-rc", [], dispatchEnv);
  cloud.check("control-plane", cpB, "failure");
  await assert.rejects(assemble(), /Checks failed for tumpel\/control-plane/);
  await assertA();
  cloud.check("control-plane", cpB, "pending");
  await assert.rejects(assemble(), /timed out after 10 observations/);
  const sleeps = "1000,2000,4000,8000,16000,32000,64000,128000,256000";
  assert.equal(readFileSync(env.SCENARIO_SLEEPS, "utf8").trim().replaceAll("\n", ","), sleeps);
  cloud.check("control-plane", cpB, "success");
  await assemble();
  const rc = cloud.dispatches.at(-1).ref,
    tagged = join(dir, "tagged");
  git(dir, "clone", "-q", "-b", rc, `${deploy}.git`, tagged);
  symlinkSync(join(root, "node_modules"), join(tagged, "node_modules"));
  const c = checkedCandidate(read(join(tagged, "release-candidate.json")));
  assert.equal(c.dashboard.url, releaseUrl("dashboard", tag.slice(1)));
  const architecture = "Amd64",
    digest = hash("fixture");
  const names = ["Shell", "ClaudeCode", "Codex", "OpenCode", "PiDev"];
  const layer = { architecture, layerDigest: digest, manifestDigest: digest, sizeBytes: 1, harnessVersion: "1" };
  write(join(tagged, "layers/amd64.json"), { harnessLayers: names.map((harness) => ({ ...layer, harness })) });
  const keys = ["imageDigest", "kernelDigest", "manifestDigest", "ociDigest", "rootfsDigest"];
  const image = { architecture, ...Object.fromEntries(keys.map((key) => [key, digest])) };
  const images = [{ ...image, harness: "Shell", harnessVersion: "1" }];
  const imageReleaseVersion = "images-v1.0.0",
    guestProtocolVersion = GuestProtocol.Version;
  put("images.json", { imageReleaseVersion, guestProtocolVersion, images, bases: [image] });
  const tagEnv = { ...deployEnv, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: rc };
  const publish = () => node(tagged, "release-publish", ["manifest", "layers"], tagEnv);
  await assert.rejects(publish(), /Client readiness is missing/);
  await assertA();

  const ready = (repo, kind, sha) => ({ repository: `tumpel/${repo}`, kind, sha, protocol, status: "Ready" });
  const consumers = [
    ready("cli", "Cli", c.clients.cli.sha),
    ready("supervisor", "Supervisor", c.clients.supervisor.sha),
    ready("control-plane", "Mcp", cpB),
  ];
  const { candidateId, stage, createdAt: observedAt } = c;
  put(`readiness/${candidateId}.json`, {
    candidateId,
    stage,
    observedAt,
    scope: "TumpelRun",
    inventoryComplete: true,
    status: "Ready",
    supervisors: [],
    consumers,
  });
  await publish();
  await node(tagged, "assemble-rc", ["--published"], deployEnv);
  git(deploy, "switch", "-q", "main");
  git(deploy, "pull", "-q", "--ff-only", "origin", "main");
  await node(deploy, "deploy", [db], deployEnv);
  assert.deepEqual(await readBack(), b);
  assert.equal(JSON.parse(current()).commit, git(tagged, "rev-parse", "HEAD"));
  assert.deepEqual(read(join(deploy, "release-pins.json")), c.pins);

  assert.deepEqual(cloud.operations, ["deploy:dashboard-site", "d1:migrations", "d1:execute", "deploy:control-plane"]);
});
