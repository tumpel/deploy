import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "npm-scripts", "prebuild.sh");
mkdirSync(join(ROOT, ".tmp"), { recursive: true });
const DIR = mkdtempSync(join(ROOT, ".tmp", "prebuild-test-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const fixture = (name, devcontainer) => {
  const root = join(DIR, name, "root");
  const workspace = join(root, "root", "workspace");
  write(join(root, "etc", "base.txt"), "base\n");
  write(join(root, "usr", "lib", "keep"), "keep\n");
  write(join(root, "usr", "lib", "gone", "nested", "file"), "gone\n");
  write(join(root, "tmp", "scratch"), "scratch\n");
  write(join(workspace, "package.json"), "{}\n");
  write(join(workspace, ".devcontainer", "devcontainer.json"), devcontainer);
  execFileSync("git", ["init", "-q", workspace]);
  return { root, out: join(DIR, name, "out") };
};

const prebuild = (root, out) =>
  spawnSync(SCRIPT, ["build", out], { env: { ...process.env, TUMPEL_PREBUILD_ROOT: root }, encoding: "utf8" });

test("the layer holds the workspace, the changed base paths and a whiteout for each removed path", () => {
  const { root, out } = fixture(
    "build",
    `{
  // comments and trailing commas are JSON with comments
  "name": "fixture",
  "onCreateCommand": "mkdir -p node_modules/a && echo on-create >> order",
  "updateContentCommand": ["sh", "-c", "echo update-content >> order"],
  "postCreateCommand": {
    "tool": "mkdir -p ${"$"}TUMPEL_PREBUILD_ROOT/usr/local/bin && echo tool > ${"$"}TUMPEL_PREBUILD_ROOT/usr/local/bin/tool",
    "prune": ["sh", "-c", "rm -r ${"$"}TUMPEL_PREBUILD_ROOT/usr/lib/gone ${"$"}TUMPEL_PREBUILD_ROOT/tmp/scratch && echo post-create >> order"],
  },
}
`,
  );
  const result = prebuild(root, out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, "root", "workspace", "order"), "utf8"),
    "on-create\nupdate-content\npost-create\n",
  );
  const layer = join(out, "layer.tar");
  const entries = execFileSync("tar", ["-tf", layer], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/\/$/, ""));
  for (const path of [
    "root/workspace",
    "root/workspace/package.json",
    "root/workspace/.devcontainer/devcontainer.json",
    "root/workspace/.git/HEAD",
    "root/workspace/node_modules/a",
    "root/workspace/order",
    "usr/local/bin/tool",
    "usr/lib/.wh.gone",
  ])
    assert.ok(entries.includes(path), `${path} is missing from ${entries.join(", ")}`);
  for (const path of ["etc/base.txt", "usr/lib/keep", "usr/lib/gone/nested/.wh.file", "tmp/.wh.scratch"])
    assert.ok(!entries.includes(path), `${path} is in the layer`);
  const bytes = readFileSync(layer);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "layer.json"), "utf8")), {
    mediaType: "application/vnd.oci.image.layer.v1.tar",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  });
});

test("features are refused with a named failure", () => {
  const { root, out } = fixture("features", '{ "features": { "ghcr.io/devcontainers/features/node:1": {} } }\n');
  const result = prebuild(root, out);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PrebuildFeaturesUnsupported/);
});
