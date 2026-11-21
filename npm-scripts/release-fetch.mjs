#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_REPOSITORY,
  cliAsset,
  downloadAsset,
  guestAsset,
  RELEASE_CACHE,
  releasePins,
  SUPERVISOR_REPOSITORY,
  supervisorAsset,
} from "./release-download.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RELEASE_BINARIES = join(ROOT, ".tmp", "release-binaries");
const ARCHITECTURE = "Amd64";

const die = (message) => {
  console.error(`release-fetch: ${message}`);
  process.exit(1);
};

const BINARIES = {
  supervisor: { repository: SUPERVISOR_REPOSITORY, asset: supervisorAsset, out: "tumpel-supervisor" },
  guest: { repository: SUPERVISOR_REPOSITORY, asset: guestAsset, out: "tumpel-guest" },
  cli: { repository: CLI_REPOSITORY, asset: cliAsset, out: "tumpel" },
};

const names = process.argv.slice(2);
const wanted = names.length === 0 ? ["supervisor", "cli"] : names;
const unknown = wanted.filter((name) => !(name in BINARIES));
if (unknown.length > 0)
  die(`no binary ${unknown.join(", ")}; usage: ${basename(process.argv[1])} [supervisor] [guest] [cli]`);
if (process.arch !== "x64") die(`the released binaries run on x64 only and this machine is ${process.arch}`);

const pins = releasePins();

mkdirSync(RELEASE_BINARIES, { recursive: true });
for (const name of wanted) {
  const { repository, asset, out } = BINARIES[name];
  const version = name === "cli" ? pins.cli : pins.supervisor;
  const { path, digest } = await downloadAsset(repository, version, asset(ARCHITECTURE), RELEASE_CACHE).catch((error) =>
    die(error.message),
  );
  const target = join(RELEASE_BINARIES, out);
  copyFileSync(path, target);
  chmodSync(target, 0o755);
  console.log(`${out} ${version} from ${repository}, sha256 ${digest}, at ${target}`);
}
