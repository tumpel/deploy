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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GuestHarnessSchema, GuestImageManifestSchema } from "@tumpel/api/schemas";
import { HARNESS_CATALOG } from "../packages/control-plane/src/harness-catalog.ts";
import { CLONE_SECONDS } from "./guest-image-settings.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.TUMPEL_IMAGE_DIR ?? join(homedir(), "development", ".tmp", "tumpel-images");
const FIRECRACKER_CI = "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261111-778a26c0594c-0";
const LAUNCHPAD = "https://launchpad.net/ubuntu/+archive/primary/+files";
const NODE_VERSION = "24.22.3";
const GIT_VERSION = "2.43.0-1ubuntu7.4";
const LIBCURL_VERSION = "8.5.0-2ubuntu10.16";
const GH_VERSION = "2.103.3";

const PINS = {
  amd64: {
    target: "x86_64-unknown-linux-gnu",
    kernel: "0ee1eb9074bfe4d90b3a6c0d3ea9c7c7b8c7563e69796fd73e7801db83a67b9f",
    rootfs: "f84ec1241d88414f43c417319fbaa31751d1cf4298f127b004c0bee8d95885c8",
    node: "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb",
    git: "c79b7948ef9860c97ec74293a90178676e63368a0711c95c28a55af4edf1adab",
    libcurl: "f3993897876cd03ea10941c9b364965ff95d0226459f31f6c5f5b93562c80798",
    gh: "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
  },
  arm64: {
    target: "aarch64-unknown-linux-gnu",
    kernel: "36640239c15df144c9defef7a74053413053de21469368e99472124e515ced80",
    rootfs: "fc6e9a413344b9ab7e3415598988a9a4a7fd8bd62fc49cf8ce5225ca3b7039b9",
    node: "6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c",
    git: "b46ef5ad7292f8ae69a7ec18c05e5b40f6c1fca837df2ce4b05b05bd46c9dc2b",
    libcurl: "057490ffc9901df7fe09913e381442fc7615bb972a1dc4198e38bcf840447e77",
    gh: "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63",
  },
};
const FIRECRACKER_ARCH = { amd64: "x86_64", arm64: "aarch64" };
const NODE_ARCH = { amd64: "x64", arm64: "arm64" };
const HOST_ARCH = { x64: "amd64", arm64: "arm64" };

const pinsFor = (arch) => {
  const pins = PINS[arch];
  const ci = `${FIRECRACKER_CI}/${FIRECRACKER_ARCH[arch]}`;
  return {
    arch,
    guestBin: process.env.TUMPEL_GUEST_BIN ?? join(ROOT, "target", pins.target, "release", "tumpel-guest"),
    kernel: { url: `${ci}/vmlinux-6.18.62`, digest: pins.kernel },
    rootfs: { url: `${ci}/ubuntu-24.04.squashfs`, digest: pins.rootfs },
    node: {
      name: "node",
      version: NODE_VERSION,
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH[arch]}.tar.xz`,
      digest: pins.node,
    },
    git: {
      name: "git",
      version: GIT_VERSION,
      url: `${LAUNCHPAD}/git_${GIT_VERSION}_${arch}.deb`,
      digest: pins.git,
    },
    libcurl: {
      name: "libcurl3t64-gnutls",
      version: LIBCURL_VERSION,
      url: `${LAUNCHPAD}/libcurl3t64-gnutls_${LIBCURL_VERSION}_${arch}.deb`,
      digest: pins.libcurl,
    },
    gh: {
      name: "gh",
      version: GH_VERSION,
      url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz`,
      digest: pins.gh,
    },
  };
};
const WORKING_DIRECTORY = "/root/workspace";
const ENVIRONMENT = {
  PATH: "/opt/tumpel/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
};
const OCI_TAG = "rootfs";
const CLAUDE_FLAGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--dangerously-skip-permissions",
];

const INIT = `#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
mount -t proc proc /proc
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
if ! mount -t ext4 -o noatime /dev/vdb /overlay 2>/dev/null; then
  mkfs.ext4 -q -F -I 256 /dev/vdb
  mount -t ext4 -o noatime /dev/vdb /overlay
  mkdir -p /overlay/upper
  if [ -b /dev/vdc ]; then
    tar -x -p --numeric-owner --xattrs --xattrs-include='trusted.overlay.*' -f /dev/vdc -C /overlay/upper
  fi
fi
mkdir -p /overlay/upper /overlay/work
mount -t overlay overlay -o lowerdir=/,upperdir=/overlay/upper,workdir=/overlay/work /mnt
mount -t devtmpfs devtmpfs /mnt/dev
umount /proc
cd /mnt
pivot_root . rom
exec chroot . /sbin/init
`;

const UNIT = `[Unit]
Description=tumpel guest agent
DefaultDependencies=no
After=local-fs.target

[Service]
ExecStart=/usr/local/bin/tumpel-guest
Restart=always
RestartSec=1
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
`;

const die = (message) => {
  console.error(`guest:image: ${message}`);
  process.exit(1);
};

const tool = (name) => {
  const found = [...(process.env.PATH ?? "").split(":"), "/usr/sbin", "/sbin"]
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path));
  if (!found) die(`${name} is not installed; install e2fsprogs, squashfs-tools, dpkg and umoci on the build machine`);
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

const download = async ({ url, digest }) => {
  const dir = join(OUT, "downloads");
  const path = join(dir, digest);
  if (existsSync(path) && (await sha256(path)) === digest) return path;
  mkdirSync(dir, { recursive: true });
  const response = await fetch(url);
  if (!response.ok) die(`downloading ${url} answered ${response.status}; check the pinned URL in this script`);
  const staged = `${path}.part`;
  writeFileSync(staged, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256(staged);
  if (actual !== digest) die(`${url} has digest ${actual}, the script pins ${digest}; refusing a changed artifact`);
  renameSync(staged, path);
  return path;
};

const TURN_PROTOCOLS = new Set(["ClaudeCode"]);

const buildable = () => [
  "Shell",
  ...HARNESS_CATALOG.filter((entry) => TURN_PROTOCOLS.has(entry.harness)).map((entry) => entry.harness),
];

const recipeFor = (name, pins) => {
  if (name === "Shell") {
    return {
      harness: GuestHarnessSchema.parse({
        harness: "Shell",
        harnessVersion: "1",
        protocol: "ShellLines",
        command: ["/bin/sh", "-s"],
        workingDirectory: WORKING_DIRECTORY,
        cloneSeconds: CLONE_SECONDS,
        environment: ENVIRONMENT,
      }),
      install: async () => [],
    };
  }
  const entry = HARNESS_CATALOG.find((candidate) => candidate.harness === name);
  if (!entry) {
    const known = ["Shell", ...HARNESS_CATALOG.map((candidate) => candidate.harness)].join(", ");
    die(`the catalog has no harness ${name}; pass one of ${known}`);
  }
  if (!TURN_PROTOCOLS.has(entry.harness))
    die(`the guest has no turn protocol for ${entry.harness} yet; build ClaudeCode or Shell`);
  const pkg = entry.installRecipe.match(/^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/);
  if (!pkg) die(`install recipe ${entry.installRecipe} is not npm:<package>@<version>`);
  const [, name_, version] = pkg;
  return {
    harness: GuestHarnessSchema.parse({
      harness: entry.harness,
      harnessVersion: entry.harnessVersion,
      protocol: "ClaudeStreamJson",
      command: ["/opt/tumpel/node/bin/node", `/opt/tumpel/harness/node_modules/${name_}/cli.js`, ...CLAUDE_FLAGS],
      workingDirectory: WORKING_DIRECTORY,
      cloneSeconds: CLONE_SECONDS,
      environment: ENVIRONMENT,
    }),
    install: async (tree) => {
      const node = join(tree, "opt", "tumpel", "node");
      mkdirSync(node, { recursive: true });
      run("tar", ["-xJf", await download(pins.node), "-C", node, "--strip-components=1", "--no-same-owner"]);
      const prefix = join(tree, "opt", "tumpel", "harness");
      mkdirSync(prefix, { recursive: true });
      run(
        process.execPath,
        [
          join(node, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
          "install",
          "--prefix",
          prefix,
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--no-save",
          "--cpu",
          NODE_ARCH[pins.arch],
          "--os",
          "linux",
          `${name_}@${version}`,
        ],
        { env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } },
      );
      return [pins.node];
    },
  };
};

const installGit = async (tree, pins) => {
  const dpkgDeb = tool("dpkg-deb");
  for (const deb of [pins.git, pins.libcurl]) run(dpkgDeb, ["-x", await download(deb), tree]);
  const local = join(tree, "usr", "local");
  run("tar", [
    "-xzf",
    await download(pins.gh),
    "-C",
    local,
    "--strip-components=1",
    "--no-same-owner",
    "--wildcards",
    "*/bin/gh",
  ]);
  return [pins.git, pins.libcurl, pins.gh];
};

const ownByRoot = (tree, image) => {
  const listing = run("find", [tree, "-mindepth", "1", "-printf", "/%P\\n"], {
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 2 ** 30,
  });
  const commands = listing.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((path) => `"${path}"`)
    .flatMap((path) => [`sif ${path} uid 0`, `sif ${path} gid 0`]);
  const script = `${image}.debugfs`;
  writeFileSync(script, `${commands.join("\n")}\n`);
  spawnSync(tool("debugfs"), ["-w", "-f", script, image], { stdio: "ignore" });
  rmSync(script);
};

const treeBytes = (tree) =>
  Number(
    run("du", ["-sb", tree], { stdio: ["ignore", "pipe", "inherit"] })
      .stdout.toString()
      .split("\t")[0],
  );

const packOci = (rootfs, layout, harness, arch) => {
  const umoci = tool("umoci");
  const image = `${layout}:${OCI_TAG}`;
  rmSync(layout, { recursive: true, force: true });
  run(umoci, ["init", "--layout", layout]);
  run(umoci, ["new", "--image", image]);
  run(umoci, [
    "config",
    "--image",
    image,
    "--no-history",
    "--os",
    "linux",
    "--architecture",
    arch,
    "--config.workingdir",
    harness.workingDirectory,
    ...Object.entries(harness.environment).flatMap(([name, value]) => ["--config.env", `${name}=${value}`]),
  ]);
  run(umoci, [
    "raw",
    "add-layer",
    "--image",
    image,
    "--history.created_by",
    `tumpel guest:image ${harness.harness} ${harness.harnessVersion}`,
    rootfs,
  ]);
  run(umoci, ["gc", "--layout", layout]);
};

const buildImage = async (name, pins) => {
  const recipe = recipeFor(name, pins);
  const [unsquashfs, mkfs, e2fsck] = [tool("unsquashfs"), tool("mkfs.ext4"), tool("e2fsck")];
  const work = join(OUT, `.build-${process.pid}`);
  const tree = join(work, "tree");
  mkdirSync(work, { recursive: true });
  try {
    run(unsquashfs, ["-no-xattrs", "-ignore-errors", "-q", "-n", "-d", tree, await download(pins.rootfs)], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    for (const dir of ["mnt", "rom", "overlay", "opt", "etc/tumpel", "usr/local/bin", "usr/local/sbin"]) {
      mkdirSync(join(tree, dir), { recursive: true });
    }
    copyFileSync(pins.guestBin, join(tree, "usr/local/bin/tumpel-guest"));
    chmodSync(join(tree, "usr/local/bin/tumpel-guest"), 0o755);
    writeFileSync(join(tree, "usr/local/sbin/tumpel-init"), INIT, { mode: 0o755 });
    writeFileSync(join(tree, "etc/systemd/system/tumpel-guest.service"), UNIT);
    symlinkSync(
      "/etc/systemd/system/tumpel-guest.service",
      join(tree, "etc/systemd/system/multi-user.target.wants/tumpel-guest.service"),
    );
    writeFileSync(join(tree, "etc/tumpel/guest.json"), `${JSON.stringify(recipe.harness, null, 2)}\n`);
    mkdirSync(join(tree, "opt/tumpel"), { recursive: true });
    copyFileSync(join(ROOT, "npm-scripts/prebuild.mjs"), join(tree, "opt/tumpel/prebuild.mjs"));
    chmodSync(join(tree, "opt/tumpel/prebuild.mjs"), 0o755);
    rmSync(join(tree, "etc/resolv.conf"), { force: true });
    writeFileSync(join(tree, "etc/resolv.conf"), "nameserver 1.1.1.1\nnameserver 9.9.9.9\n");
    const components = [...(await installGit(tree, pins)), ...(await recipe.install(tree))];
    run("chmod", ["-R", "u+rwX", tree]);
    const image = join(work, "image.ext4");
    const mib = Math.ceil((treeBytes(tree) * 1.3) / 2 ** 20) + 256;
    run(mkfs, ["-q", "-F", "-d", tree, "-E", "root_owner=0:0", "-L", "rootfs", image, `${mib}M`]);
    ownByRoot(tree, image);
    run(e2fsck, ["-fn", image], { stdio: ["ignore", "ignore", "inherit"] });
    const imageDigest = await sha256(image);
    const kernel = await download(pins.kernel);
    copyFileSync(kernel, join(OUT, `${pins.kernel.digest}.vmlinux`));
    renameSync(image, join(OUT, `${imageDigest}.ext4`));
    const rootfs = join(OUT, `${imageDigest}.rootfs.tar`);
    run("tar", ["-C", tree, "--sort=name", "--numeric-owner", "--owner=0", "--group=0", "-cf", rootfs, "."]);
    packOci(rootfs, join(OUT, `oci-${imageDigest}`), recipe.harness, pins.arch);
    const manifest = GuestImageManifestSchema.parse({
      imageDigest,
      kernelUrl: pins.kernel.url,
      kernelDigest: pins.kernel.digest,
      baseRootfsUrl: pins.rootfs.url,
      baseRootfsDigest: pins.rootfs.digest,
      harness: recipe.harness,
      components,
    });
    const manifestPath = join(OUT, `${imageDigest}.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(manifestPath);
  } finally {
    run("chmod", ["-R", "u+w", work]);
    rmSync(work, { recursive: true, force: true });
  }
};

const main = async () => {
  const [name, arch = HOST_ARCH[process.arch]] = process.argv.slice(2);
  if (!name)
    die(
      `pass a harness and optionally an architecture: npm run guest:image -- <${buildable().join("|")}|all> [amd64|arm64]`,
    );
  if (!PINS[arch]) die(`no pins for architecture ${arch}; pass amd64 or arm64`);
  const pins = pinsFor(arch);
  if (!existsSync(pins.guestBin))
    die(`${pins.guestBin} is missing; build it with TUMPEL_TARGET=${PINS[arch].target} npm run guest:build`);
  for (const harness of name === "all" ? buildable() : [name]) await buildImage(harness, pins);
};

await main();
