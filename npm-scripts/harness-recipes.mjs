import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GuestHarnessSchema } from "@tumpel/api/schemas";
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

const NPM_RECIPE = /^npm:((?:@[^/]+\/)?[^@]+)@(\S+)$/;
const ARCHIVE_RECIPE = /^archive:(amd64|arm64):(\S+)#sha256=([0-9a-f]{64})$/;

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
  const npm = entry.installRecipe.match(NPM_RECIPE);
  if (npm) {
    const [, packageName, version] = npm;
    return {
      kind: "NpmNative",
      installRecipe: entry.installRecipe,
      package: `${packageName}-linux-${NODE_ARCH[arch]}`,
      version,
      cpu: NODE_ARCH[arch],
      binary: run.binary,
    };
  }
  const archives = entry.installRecipe.split(" ").map((part) => part.match(ARCHIVE_RECIPE));
  const archive = archives.find((match) => match?.[1] === arch);
  if (archives.includes(null) || !archive)
    throw new Error(
      `install recipe ${entry.installRecipe} of ${entry.harness} is neither npm:<package>@<version> nor an archive:<arch>:<url>#sha256=<digest> for ${arch}; fix it in harness-catalog.ts`,
    );
  if (run.stripComponents === undefined)
    throw new Error(`HARNESS_RUNS names no stripComponents for ${entry.harness}; add it in guest-image-settings.mjs`);
  const [, , url, digest] = archive;
  return {
    kind: "Archive",
    url,
    digest,
    stripComponents: run.stripComponents,
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
  const installed = join(bin, install.binary);
  if (!existsSync(installed))
    throw new Error(`${install.url} holds no ${install.binary}; check the install recipe in harness-catalog.ts`);
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
