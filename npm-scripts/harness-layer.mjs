#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HarnessLayerManifestSchema } from "@tumpel/api/schemas";
import { extractArchive, layerHarnesses, layerRecipe, MKSQUASHFS_FLAGS } from "./harness-recipes.mjs";
import { disabledReason, RELEASE_ARCHITECTURES } from "./release-architectures.mjs";

const OUT = process.env.TUMPEL_LAYER_DIR ?? join(homedir(), "development", ".tmp", "tumpel-layers");
const HOST_ARCH = { x64: "amd64", arm64: "arm64" };

const die = (message) => {
  console.error(`harness:layer: ${message}`);
  process.exit(1);
};

const tool = (name) => {
  const found = [...(process.env.PATH ?? "").split(":"), "/usr/sbin", "/sbin"]
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path));
  if (!found) die(`${name} is not installed; install squashfs-tools 4.6.1 or newer on the build machine`);
  return found;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  return result;
};

const sha256 = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

const installNpmNative = (install, tree, work) => {
  const npm = process.env.npm_execpath;
  if (!npm) die("npm_execpath is not set; run this as npm run harness:layer");
  const prefix = join(work, "npm");
  mkdirSync(prefix, { recursive: true });
  run(process.execPath, [
    npm,
    "install",
    "--prefix",
    prefix,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--cpu",
    install.cpu,
    "--os",
    "linux",
    "--libc",
    "glibc",
    "--ignore-scripts",
    `${install.package}@${install.version}`,
  ]);
  const installed = join(prefix, "node_modules", install.package, install.binary);
  if (!existsSync(installed))
    die(`npm installed no ${installed}; check that ${install.package}@${install.version} is published`);
  const bin = join(tree, "bin", install.binary);
  copyFileSync(installed, bin);
  chmodSync(bin, 0o755);
};

const installArchive = async (install, tree, work) => {
  const response = await fetch(install.url);
  if (!response.ok)
    die(`downloading ${install.url} answered ${response.status}; check the install recipe in harness-catalog.ts`);
  const archive = join(work, "archive.tar.gz");
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256(archive);
  if (actual !== install.digest)
    die(`${install.url} has digest ${actual}, harness-catalog.ts pins ${install.digest}; refusing a changed artifact`);
  extractArchive(archive, join(tree, "bin"), install);
};

const buildLayer = async (name, arch) => {
  const recipe = layerRecipe(name, arch);
  const mksquashfs = tool("mksquashfs");
  const work = join(OUT, `.build-${process.pid}`);
  const tree = join(work, "tree");
  mkdirSync(join(tree, "bin"), { recursive: true });
  try {
    if (recipe.install.kind === "NpmNative") installNpmNative(recipe.install, tree, work);
    if (recipe.install.kind === "Archive") await installArchive(recipe.install, tree, work);
    writeFileSync(join(tree, "tumpel-harness.json"), `${JSON.stringify(recipe.harness, null, 2)}\n`);
    run("chmod", ["-R", "u+rwX,go+rX,go-w", tree]);
    const layer = join(work, "layer.squashfs");
    run(mksquashfs, [tree, layer, ...MKSQUASHFS_FLAGS], { stdio: ["ignore", "ignore", "inherit"] });
    const layerDigest = await sha256(layer);
    renameSync(layer, join(OUT, `${layerDigest}.squashfs`));
    const manifest = HarnessLayerManifestSchema.parse({
      layerDigest,
      recipeDigest: recipe.recipeDigest,
      architecture: recipe.architecture,
      harness: recipe.harness,
    });
    const manifestPath = join(OUT, `${layerDigest}.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(manifestPath);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

const main = async () => {
  const [name, arch = HOST_ARCH[process.arch]] = process.argv.slice(2);
  if (!name)
    die(`pass a harness and an architecture: npm run harness:layer -- <${layerHarnesses().join("|")}> <amd64|arm64>`);
  if (!RELEASE_ARCHITECTURES.includes(arch)) die(disabledReason(arch));
  await buildLayer(name, arch);
};

await main();
