import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GuestHarnessSchema } from "@tumpel/api/schemas";
import { HARNESS_CATALOG } from "../packages/control-plane/src/harness-catalog.ts";
import {
  CLONE_SECONDS,
  ENVIRONMENT,
  HARNESS_RUNS,
  harnessArchive,
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
  });
  if (run.archive) {
    const { name: binary, version, url, digest, stripComponents } = harnessArchive(entry, arch);
    return { harness, install: { kind: "Archive", url, digest, stripComponents, version, binary } };
  }
  const pkg = entry.installRecipe.match(/^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/);
  if (!pkg) throw new Error(`install recipe ${entry.installRecipe} is not npm:<package>@<version>`);
  const [, packageName, version] = pkg;
  if (version !== entry.harnessVersion)
    throw new Error(
      `install recipe ${entry.installRecipe} installs ${version}, the catalog names ${entry.harnessVersion}; make them match`,
    );
  return {
    harness,
    install: {
      kind: "NpmNative",
      installRecipe: entry.installRecipe,
      package: `${packageName}-linux-${NODE_ARCH[arch]}`,
      version,
      cpu: NODE_ARCH[arch],
      binary: run.binary,
    },
  };
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
