#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GuestImageManifestSchema } from "@tumpel/api/schemas";

const TAG = "rootfs";
const PATH_ENV = "PATH=/opt/tumpel/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const ARCHITECTURES = new Set(["amd64", "arm64"]);

const die = (message) => {
  console.error(`guest:oci: ${message}`);
  process.exit(1);
};

const umoci = (args) => {
  const result = spawnSync("umoci", args, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) die(`umoci could not run (${result.error.message}); install umoci (apt-get install umoci)`);
  if (result.status !== 0) die(`umoci ${args.join(" ")} exited with ${result.status ?? result.signal}`);
};

const pack = (imageDir, arch, manifestName) => {
  const manifest = GuestImageManifestSchema.parse(JSON.parse(readFileSync(join(imageDir, manifestName), "utf8")));
  const rootfs = join(imageDir, `${manifest.imageDigest}.rootfs.tar`);
  if (!existsSync(rootfs)) die(`${rootfs} is missing; build the image again with npm run guest:image`);
  const layout = join(imageDir, `oci-${manifest.imageDigest}`);
  const image = `${layout}:${TAG}`;
  rmSync(layout, { recursive: true, force: true });
  umoci(["init", "--layout", layout]);
  umoci(["new", "--image", image]);
  umoci([
    "config",
    "--image",
    image,
    "--no-history",
    "--os",
    "linux",
    "--architecture",
    arch,
    "--config.workingdir",
    manifest.harness.workingDirectory,
    "--config.env",
    PATH_ENV,
  ]);
  umoci([
    "raw",
    "add-layer",
    "--image",
    image,
    "--history.created_by",
    `tumpel guest:image ${manifest.harness.harness} ${manifest.harness.harnessVersion}`,
    rootfs,
  ]);
  umoci(["gc", "--layout", layout]);
  console.log(layout);
};

const main = () => {
  const [imageDir, arch] = process.argv.slice(2);
  if (!imageDir || !ARCHITECTURES.has(arch))
    die("pass the image directory and an architecture: npm run guest:oci -- <dir> <amd64|arm64>");
  const manifests = readdirSync(imageDir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  if (manifests.length === 0) die(`${imageDir} holds no <imageDigest>.json; build the images with npm run guest:image`);
  for (const name of manifests) pack(imageDir, arch, name);
};

main();
