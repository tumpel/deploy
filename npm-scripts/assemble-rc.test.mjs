import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("dispatch requires client evidence before pin and tag writes, while manual assembly still releases", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "assemble-rc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "deploy");
  const origin = join(dir, "origin.git");
  mkdirSync(checkout);
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", timeout: 10_000 }).trim();
  git("init", "--quiet", "--bare", "--initial-branch=main", origin);
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.test");
  git("remote", "add", "origin", origin);

  const pinsPath = join(checkout, "release-pins.json");
  const originalPins = '{"cli":"1.0.0"}\n';
  writeFileSync(pinsPath, originalPins);
  git("add", "release-pins.json");
  git("commit", "--quiet", "-m", "chore: pin release A");
  git("tag", "v1.0.0");
  git("push", "--quiet", "origin", "main", "v1.0.0");
  const initialCommit = git("rev-parse", "HEAD");

  cpSync(new URL(".", import.meta.url), join(checkout, "npm-scripts"), { recursive: true });
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(checkout, "node_modules"), "dir");
  const bin = join(dir, "bin");
  const calls = join(dir, "github-calls");
  mkdirSync(bin);
  writeFileSync(calls, "");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
if (args.join(" ") === "api repos/tumpel/cli/releases?per_page=100") {
  console.log(JSON.stringify([{ tag_name: "v1.0.1", draft: false }]));
} else if (args.join(" ") !== "workflow run release.yml --ref v1.0.1-rc.1 -f stage=dev") {
  throw new Error("Unexpected GitHub call: " + args.join(" "));
}
`,
    { mode: 0o755 },
  );

  const assemble = (event) =>
    spawnSync(process.execPath, ["npm-scripts/assemble-rc.mjs"], {
      cwd: checkout,
      env: { PATH: `${bin}${delimiter}${process.env.PATH}`, GITHUB_EVENT_NAME: event },
      encoding: "utf8",
      timeout: 10_000,
    });

  for (const candidate of [undefined, {}]) {
    if (candidate) writeFileSync(join(checkout, "release-candidate.json"), JSON.stringify(candidate));
    const result = assemble("repository_dispatch");
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.match(result.stderr, /Candidate client readiness evidence is missing/);
    assert.equal(readFileSync(pinsPath, "utf8"), originalPins);
    assert.equal(git("symbolic-ref", "--short", "HEAD"), "main");
    assert.equal(git("rev-parse", "HEAD", "origin/main"), `${initialCommit}\n${initialCommit}`);
    assert.equal(git("tag", "--list"), "v1.0.0");
    assert.equal(readFileSync(calls, "utf8"), "");
  }

  const result = assemble("workflow_dispatch");
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /advancing pins before starting the existing release workflow/);
  assert.deepEqual(JSON.parse(git("show", "origin/main:release-pins.json")), { cli: "1.0.1" });
  assert.equal(git("rev-parse", "origin/main"), git("rev-parse", "v1.0.1-rc.1"));
  assert.match(readFileSync(calls, "utf8"), /^workflow run release\.yml --ref v1\.0\.1-rc\.1 -f stage=dev$/m);
});
