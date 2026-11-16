import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { GuestHarnessSchema } from "@tumpel/schemas";
import { HARNESS_CATALOG } from "../packages/control-plane/src/harness-catalog.ts";
import {
  CLONE_SECONDS,
  ENVIRONMENT,
  HARNESS_RUNS,
  NODE_ARCH,
  TURN_PROTOCOLS,
  WORKING_DIRECTORY,
} from "./guest-image-settings.mjs";

export const LAYER_ROOT = "/opt/harness";
export const MKSQUASHFS_FLAGS = ["-comp", "zstd", "-all-root", "-all-time", "0", "-mkfs-time", "0"];
export const LAYER_ARCHITECTURES = { amd64: "Amd64", arm64: "Arm64" };

const BUILD_SOURCES = ["harness-recipes.mjs", "harness-layer.mjs"].map((name) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
);

export const layerHarnesses = () => [
  "Shell",
  ...HARNESS_CATALOG.filter((entry) => TURN_PROTOCOLS.has(entry.harness)).map((entry) => entry.harness),
];

const rootOf = (harness, harnessVersion) => `${LAYER_ROOT}/${harness}/${harnessVersion}`;

const shellRecipe = () => ({
  harness: GuestHarnessSchema.parse({
    harness: "Shell",
    harnessVersion: "1",
    protocol: "ShellLines",
    command: ["/bin/sh", "-s"],
    workingDirectory: WORKING_DIRECTORY,
    cloneSeconds: CLONE_SECONDS,
    environment: ENVIRONMENT,
    fixedVariables: [],
  }),
  install: { kind: "None" },
});

const catalogRecipe = (name, arch) => {
  const entry = HARNESS_CATALOG.find((candidate) => candidate.harness === name);
  if (!entry) throw new Error(`the catalog has no harness ${name}; pass one of ${layerHarnesses().join(", ")}`);
  if (!TURN_PROTOCOLS.has(entry.harness))
    throw new Error(`the guest has no turn protocol for ${entry.harness} yet; build ${layerHarnesses().join(" or ")}`);
  const run = HARNESS_RUNS[entry.harness];
  const root = rootOf(entry.harness, entry.harnessVersion);
  const harness = GuestHarnessSchema.parse({
    harness: entry.harness,
    harnessVersion: entry.harnessVersion,
    protocol: run.protocol,
    command: [`${root}/bin/${run.binary}`, ...run.flags],
    workingDirectory: WORKING_DIRECTORY,
    cloneSeconds: CLONE_SECONDS,
    environment: ENVIRONMENT,
    fixedVariables: run.fixedVariables,
  });
  return { harness, install: installOf(entry, run, arch) };
};

const installOf = (entry, run, arch) => {
  const recipe = entry.installRecipe;
  if (recipe.kind === "Npm") {
    return {
      kind: "NpmNative",
      package: `${recipe.package}-linux-${NODE_ARCH[arch]}`,
      version: recipe.packageVersion,
      cpu: NODE_ARCH[arch],
      binary: run.binary,
    };
  }
  const archive = recipe.archives.find((each) => each.architecture === LAYER_ARCHITECTURES[arch]);
  if (!archive)
    throw new Error(
      `the install recipe of ${entry.harness} ${entry.harnessVersion} names no archive for ${LAYER_ARCHITECTURES[arch]}; add one in harness-catalog.ts`,
    );
  return {
    kind: "Archive",
    url: archive.url,
    digest: archive.sha256,
    stripComponents: recipe.stripComponents,
    binaryPath: archive.binaryPath,
    version: entry.harnessVersion,
    binary: run.binary,
  };
};

export const extractArchive = (archive, bin, install) => {
  const result = spawnSync(
    "tar",
    ["-xzf", archive, "-C", bin, `--strip-components=${install.stripComponents}`, "--no-same-owner"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.status !== 0)
    throw new Error(`tar could not unpack ${install.url}; it exited with ${result.status ?? result.signal}`);
  const unpacked = join(bin, install.binaryPath);
  if (!existsSync(unpacked))
    throw new Error(`${install.url} holds no ${install.binaryPath}; check the install recipe in harness-catalog.ts`);
  const installed = join(bin, install.binary);
  if (unpacked !== installed) renameSync(unpacked, installed);
  chmodSync(installed, 0o755);
};

export const layerRecipe = (name, arch) => {
  if (!LAYER_ARCHITECTURES[arch]) throw new Error(`no architecture ${arch}; pass amd64 or arm64`);
  const recipe = name === "Shell" ? shellRecipe() : catalogRecipe(name, arch);
  const recipeDigest = createHash("sha256")
    .update(JSON.stringify({ arch, harness: recipe.harness, install: recipe.install, flags: MKSQUASHFS_FLAGS }))
    .update(BUILD_SOURCES.join("\n"))
    .digest("hex");
  return {
    ...recipe,
    arch,
    architecture: LAYER_ARCHITECTURES[arch],
    root: rootOf(recipe.harness.harness, recipe.harness.harnessVersion),
    recipeDigest,
  };
};

export const recipeKey = (recipe) =>
  `layers/${recipe.harness.harness}/${recipe.harness.harnessVersion}/${recipe.arch}/recipes/${recipe.recipeDigest}`;

export const layerPrefix = (recipe) =>
  `layers/${recipe.harness.harness}/${recipe.harness.harnessVersion}/${recipe.arch}`;
