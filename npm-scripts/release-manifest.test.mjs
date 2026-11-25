import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseManifest } from "./release-manifest.mjs";

const D = "a".repeat(64);
const supervisor = (supervisorVersion) => [
  {
    architecture: "Amd64",
    sha256: D,
    sizeBytes: 10,
    supervisorVersion,
    downloadUrl: `https://github.com/tumpel/supervisor/releases/download/v${supervisorVersion}/tumpel-supervisor-x86_64-linux`,
    guestProtocolVersion: 11,
  },
];
const cli = (cliVersion) => [
  {
    architecture: "Amd64",
    sha256: D,
    sizeBytes: 10,
    cliVersion,
    downloadUrl: `https://github.com/tumpel/cli/releases/download/v${cliVersion}/tumpel-x86_64-linux`,
  },
];
const fields = (commit, supervisors, clis) => ({
  releaseVersion: `0.0.0-${commit.slice(0, 12)}`,
  commit,
  channelProtocolVersion: 19,
  supervisors,
  clis,
  images: [],
  harnessLayers: [
    { harness: "Shell", harnessVersion: "1", architecture: "Amd64", layerDigest: D, manifestDigest: D, sizeBytes: 1 },
  ],
  bases: [{ architecture: "Amd64", imageDigest: D, kernelDigest: D, manifestDigest: D, ociDigest: D, rootfsDigest: D }],
});

test("a supervisor downgrade sets rollback, a CLI-only publish keeps it, and a supervisor upgrade clears it", () => {
  const upgraded = releaseManifest(fields("1".repeat(40), supervisor("0.3.0"), cli("1.0.0-rc.24")), undefined);
  assert.equal(upgraded.rollback, undefined);

  const reverted = releaseManifest(fields("2".repeat(40), supervisor("0.3.0-rc.34"), cli("1.0.0-rc.24")), upgraded);
  assert.equal(reverted.rollback, true);

  const cliOnly = releaseManifest(fields("3".repeat(40), supervisor("0.3.0-rc.34"), cli("1.0.0-rc.25")), reverted);
  assert.equal(cliOnly.rollback, true);

  const forward = releaseManifest(fields("4".repeat(40), supervisor("0.3.0-rc.35"), cli("1.0.0-rc.25")), cliOnly);
  assert.equal(forward.rollback, undefined);
});

test("a stable supervisor downgrade keeps rollback through a CLI-only publish", () => {
  const upgraded = releaseManifest(fields("1".repeat(40), supervisor("0.3.0"), cli("1.0.0")), undefined);
  const reverted = releaseManifest(fields("2".repeat(40), supervisor("0.2.9"), cli("1.0.0")), upgraded);
  assert.equal(reverted.rollback, true);

  const cliOnly = releaseManifest(fields("3".repeat(40), supervisor("0.2.9"), cli("1.0.1")), reverted);
  assert.equal(cliOnly.rollback, true);
});

test("an unchanged supervisor without rollback stays without it", () => {
  const before = releaseManifest(fields("1".repeat(40), supervisor("0.3.0-rc.34"), cli("1.0.0-rc.24")), undefined);
  const after = releaseManifest(fields("2".repeat(40), supervisor("0.3.0-rc.34"), cli("1.0.0-rc.25")), before);
  assert.equal(after.rollback, undefined);
});

test("a CLI revert leaves the supervisor entry byte-identical", () => {
  const before = releaseManifest(fields("1".repeat(40), supervisor("0.3.0-rc.34"), cli("1.0.0-rc.25")), undefined);
  const after = releaseManifest(fields("2".repeat(40), supervisor("0.3.0-rc.34"), cli("1.0.0-rc.24")), before);
  assert.equal(JSON.stringify(after.supervisors), JSON.stringify(before.supervisors));
  assert.equal(after.rollback, before.rollback);
  assert.equal(after.clis[0].cliVersion, "1.0.0-rc.24");
});
