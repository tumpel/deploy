import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pinnedCommit } from "./pinned-source.mjs";

const REPOSITORY = "https://github.com/tumpel/control-plane.git";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pin = pinnedCommit("control-plane");

const SOURCE = join(ROOT, ".tmp", "control-plane", pin);

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"], timeout: 600_000 });
  if (result.error) throw new Error(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
};

const checkout = () => {
  if (existsSync(join(SOURCE, "node_modules"))) return;
  const staging = `${SOURCE}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  run("git", ["init", "--quiet"], staging);
  run("git", ["fetch", "--quiet", "--depth", "1", REPOSITORY, pin], staging);
  run("git", ["checkout", "--quiet", "FETCH_HEAD"], staging);
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], staging);
  rmSync(SOURCE, { recursive: true, force: true });
  renameSync(staging, SOURCE);
};

checkout();

export const controlPlaneModule = (path) => import(pathToFileURL(join(SOURCE, path)).href);

export const controlPlanePackage = (name) =>
  import(pathToFileURL(createRequire(join(SOURCE, "packages", "control-plane", "package.json")).resolve(name)).href);
