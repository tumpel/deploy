import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CARGO_BUILD_JOBS_CONFIG, CARGO_BUILD_JOBS_GENERATOR } from "./guest-image-settings.mjs";

const BIN = mkdtempSync(join(tmpdir(), "tumpel-cargo-jobs-"));
after(() => rmSync(BIN, { recursive: true, force: true }));
writeFileSync(join(BIN, "awk"), `#!/bin/sh\nprintf '%s\\n' "$TEST_MEMORY_KIB"\n`, { mode: 0o755 });
writeFileSync(join(BIN, "nproc"), `#!/bin/sh\nprintf '%s\\n' "$TEST_CPUS"\n`, { mode: 0o755 });

const runGenerator = (memoryKib, cpus, cargoBuildJobs) => {
  const result = spawnSync("/bin/sh", {
    input: CARGO_BUILD_JOBS_GENERATOR,
    encoding: "utf8",
    env: {
      PATH: BIN,
      TEST_MEMORY_KIB: String(memoryKib),
      TEST_CPUS: String(cpus),
      ...(cargoBuildJobs === undefined ? {} : { CARGO_BUILD_JOBS: cargoBuildJobs }),
    },
  });
  assert.equal(result.status, 0);
  return result.stdout;
};

test("cargo jobs fit the box memory and CPU count", () => {
  assert.equal(runGenerator(1024 * 1024, 8), "CARGO_BUILD_JOBS=1\n");
  assert.equal(runGenerator(4 * 1024 * 1024, 8), "CARGO_BUILD_JOBS=2\n");
  assert.equal(runGenerator(16 * 1024 * 1024, 8), "CARGO_BUILD_JOBS=8\n");
});

test("cargo jobs keep an existing value", () => {
  assert.equal(runGenerator(4 * 1024 * 1024, 8, "6"), "");
});

test("cargo jobs become a harness default", () => {
  const config = join(BIN, "guest.json");
  writeFileSync(config, JSON.stringify({ fixedVariables: [] }));
  const result = spawnSync("/bin/sh", ["-s", "--", config], {
    input: CARGO_BUILD_JOBS_CONFIG,
    encoding: "utf8",
    env: { ...process.env, CARGO_BUILD_JOBS: "2" },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(config)), {
    fixedVariables: [{ name: "CARGO_BUILD_JOBS", value: "2" }],
  });
});

test("cargo jobs keep a harness value", () => {
  const config = join(BIN, "configured-guest.json");
  writeFileSync(config, JSON.stringify({ fixedVariables: [{ name: "CARGO_BUILD_JOBS", value: "6" }] }));
  const result = spawnSync("/bin/sh", ["-s", "--", config], {
    input: CARGO_BUILD_JOBS_CONFIG,
    encoding: "utf8",
    env: { ...process.env, CARGO_BUILD_JOBS: "2" },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(config)), {
    fixedVariables: [{ name: "CARGO_BUILD_JOBS", value: "6" }],
  });
});
