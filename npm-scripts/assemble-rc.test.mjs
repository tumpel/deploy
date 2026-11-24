import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assembleRc } from "./assemble-rc.mjs";

test("assembly tags one pin commit and skips unchanged pins on the tagged head", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "assemble-rc-"));
  t.after(() => rmSync(root, { recursive: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
  const pinned = "a".repeat(40);
  const latest = "b".repeat(40);
  git("init", "-q");
  const pins = { controlPlane: pinned, cli: "1.0.0" };
  writeFileSync(join(root, "release-pins.json"), JSON.stringify(pins));
  writeFileSync(join(root, "release-candidate.json"), "invalid candidate");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial pins");
  git("tag", "v1.0.0");

  const github = async (path) => {
    if (path === "/repos/tumpel/cli/releases?per_page=100") return [{ tag_name: "v1.0.1" }];
    if (path === "/repos/tumpel/control-plane/actions/runs?branch=main&event=push&status=success&per_page=50")
      return { workflow_runs: [{ name: "checks", head_sha: latest }] };
    if (path === `/repos/tumpel/control-plane/compare/${pinned}...${latest}`) return { status: "ahead" };
    assert.equal(path, `/repos/tumpel/control-plane/compare/${latest}...${latest}`);
    return { status: "identical" };
  };
  const remoteCalls = [];
  const command = (name, args) => {
    if (name === "git" && args[0] !== "push") return git(...args);
    remoteCalls.push([name, ...args]);
  };
  const options = { root, github, command, stage: "dev" };
  const tag = "v1.0.1-rc.1";
  assert.equal(await assembleRc(options), tag);
  const head = git("rev-parse", tag);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("rev-list", "--count", `v1.0.0..${tag}`), "1");
  assert.equal(git("diff", "--name-only", "v1.0.0", tag), "release-pins.json");
  assert.deepEqual(JSON.parse(git("show", `${tag}:release-pins.json`)), { controlPlane: latest, cli: "1.0.1" });

  assert.equal(await assembleRc(options), undefined);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("tag", "--list"), `v1.0.0\n${tag}`);
  assert.deepEqual(remoteCalls, [
    ["git", "push", "origin", "HEAD:refs/heads/main"],
    ["git", "push", "origin", `refs/tags/${tag}`],
    ["gh", "workflow", "run", "release.yml", "--ref", tag, "-f", "stage=dev"],
  ]);
});
