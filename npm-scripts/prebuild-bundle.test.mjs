import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundlePrebuild } from "./prebuild-bundle.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(ROOT, ".tmp"), { recursive: true });
const DIR = mkdtempSync(join(ROOT, ".tmp", "prebuild-bundle-test-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

test("the bundled prebuild.mjs runs alone in an empty directory", async () => {
  const dir = join(DIR, "empty");
  mkdirSync(dir);
  await bundlePrebuild(join(dir, "prebuild.mjs"));
  const result = spawnSync(process.execPath, ["prebuild.mjs"], { cwd: dir, encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^prebuild: usage:/);
});
