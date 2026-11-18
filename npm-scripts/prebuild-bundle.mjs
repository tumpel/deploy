import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "prebuild.mjs");

export const bundlePrebuild = async (outfile) => {
  await build({ entryPoints: [ENTRY], outfile, bundle: true, platform: "node", format: "esm", target: "node22" });
  chmodSync(outfile, 0o755);
};
