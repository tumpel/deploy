import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CARGO_BUILD_CONFIG } from "./guest-image-settings.mjs";

const BIN = mkdtempSync(join(tmpdir(), "tumpel-cargo-jobs-"));
after(() => rmSync(BIN, { recursive: true, force: true }));
writeFileSync(join(BIN, "awk"), `#!/bin/sh\nprintf '%s\\n' "$TEST_MEMORY_KIB"\n`, { mode: 0o755 });
writeFileSync(join(BIN, "nproc"), `#!/bin/sh\nprintf '%s\\n' "$TEST_CPUS"\n`, { mode: 0o755 });

const configure = (name, memoryKib, cpus) => {
  const config = join(BIN, name);
  const result = spawnSync("/bin/sh", ["-s", "--", config], {
    input: CARGO_BUILD_CONFIG,
    encoding: "utf8",
    env: { PATH: `${BIN}:/usr/bin:/bin`, TEST_MEMORY_KIB: String(memoryKib), TEST_CPUS: String(cpus) },
  });
  assert.equal(result.status, 0);
  return readFileSync(config, "utf8");
};

test("cargo jobs fit the box memory and CPU count", () => {
  assert.equal(configure("small.toml", 1024 * 1024, 8), "[build]\njobs = 1\n");
  assert.equal(configure("four-gib.toml", 4 * 1024 * 1024, 8), "[build]\njobs = 2\n");
  assert.equal(configure("large.toml", 16 * 1024 * 1024, 8), "[build]\njobs = 8\n");
});

test("cargo jobs keep an existing user config", () => {
  const config = join(BIN, "configured.toml");
  writeFileSync(config, "[build]\njobs = 6\n");
  assert.equal(configure("configured.toml", 4 * 1024 * 1024, 8), "[build]\njobs = 6\n");
});
