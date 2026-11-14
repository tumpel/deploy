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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.TUMPEL_IMAGE_DIR ?? join(homedir(), "development", ".tmp", "tumpel-images");
const GUEST_BIN =
  process.env.TUMPEL_GUEST_BIN ?? join(ROOT, "target", "x86_64-unknown-linux-gnu", "release", "tumpel-guest");
const CI = "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261111-778a26c0594c-0/x86_64";
const KERNEL = {
  url: `${CI}/vmlinux-6.18.62`,
  digest: "0ee1eb9074bfe4d90b3a6c0d3ea9c7c7b8c7563e69796fd73e7801db83a67b9f",
};
const ROOTFS = {
  url: `${CI}/ubuntu-24.04.squashfs`,
  digest: "f84ec1241d88414f43c417319fbaa31751d1cf4298f127b004c0bee8d95885c8",
};
const NODE = {
  name: "node",
  version: "24.22.3",
  url: "https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz",
  digest: "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb",
};
const LAUNCHPAD = "https://launchpad.net/ubuntu/+archive/primary/+files";
const GIT = {
  name: "git",
  version: "2.43.0-1ubuntu7.4",
  url: `${LAUNCHPAD}/git_2.43.0-1ubuntu7.4_amd64.deb`,
  digest: "c79b7948ef9860c97ec74293a90178676e63368a0711c95c28a55af4edf1adab",
};
const LIBCURL_GNUTLS = {
  name: "libcurl3t64-gnutls",
  version: "8.5.0-2ubuntu10.16",
  url: `${LAUNCHPAD}/libcurl3t64-gnutls_8.5.0-2ubuntu10.16_amd64.deb`,
  digest: "f3993897876cd03ea10941c9b364965ff95d0226459f31f6c5f5b93562c80798",
};
const GH = {
  name: "gh",
  version: "2.103.3",
  url: "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz",
  digest: "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
};
const WORKING_DIRECTORY = "/root/workspace";
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
  mkfs.ext4 -q -F /dev/vdb
  mount -t ext4 -o noatime /dev/vdb /overlay
  mkdir -p /overlay/upper
  if [ -b /dev/vdc ]; then
    tar -x -p --numeric-owner -f /dev/vdc -C /overlay/upper
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
  if (!found) die(`${name} is not installed; install e2fsprogs, squashfs-tools and dpkg on the build machine`);
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

const recipeFor = (name) => {
  if (name === "Shell") {
    return {
      harness: GuestHarnessSchema.parse({
        harness: "Shell",
        harnessVersion: "1",
        protocol: "ShellLines",
        command: ["/bin/sh", "-s"],
        workingDirectory: WORKING_DIRECTORY,
      }),
      install: async () => [],
    };
  }
  const entry = HARNESS_CATALOG.find((candidate) => candidate.harness === name);
  if (!entry) {
    const known = ["Shell", ...HARNESS_CATALOG.map((candidate) => candidate.harness)].join(", ");
    die(`the catalog has no harness ${name}; pass one of ${known}`);
  }
  if (entry.harness !== "ClaudeCode")
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
    }),
    install: async (tree) => {
      const node = join(tree, "opt", "tumpel", "node");
      mkdirSync(node, { recursive: true });
      run("tar", ["-xJf", await download(NODE), "-C", node, "--strip-components=1", "--no-same-owner"]);
      const prefix = join(tree, "opt", "tumpel", "harness");
      mkdirSync(prefix, { recursive: true });
      run(
        join(node, "bin", "node"),
        [
          join(node, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
          "install",
          "--prefix",
          prefix,
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--no-save",
          `${name_}@${version}`,
        ],
        { env: { ...process.env, PATH: `${join(node, "bin")}:${process.env.PATH}` } },
      );
      return [NODE];
    },
  };
};

const installGit = async (tree) => {
  const dpkgDeb = tool("dpkg-deb");
  for (const deb of [GIT, LIBCURL_GNUTLS]) run(dpkgDeb, ["-x", await download(deb), tree]);
  const local = join(tree, "usr", "local");
  run("tar", [
    "-xzf",
    await download(GH),
    "-C",
    local,
    "--strip-components=1",
    "--no-same-owner",
    "--wildcards",
    "*/bin/gh",
  ]);
  return [GIT, LIBCURL_GNUTLS, GH];
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

const main = async () => {
  const name = process.argv[2];
  if (!name) die("pass a harness: npm run guest:image -- Shell, or -- ClaudeCode");
  if (!existsSync(GUEST_BIN)) die(`${GUEST_BIN} is missing; build it with npm run guest:build`);
  const recipe = recipeFor(name);
  const [unsquashfs, mkfs, e2fsck] = [tool("unsquashfs"), tool("mkfs.ext4"), tool("e2fsck")];
  const work = join(OUT, `.build-${process.pid}`);
  const tree = join(work, "tree");
  mkdirSync(work, { recursive: true });
  try {
    run(unsquashfs, ["-no-xattrs", "-ignore-errors", "-q", "-n", "-d", tree, await download(ROOTFS)], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    for (const dir of ["mnt", "rom", "overlay", "opt", "etc/tumpel", "usr/local/bin", "usr/local/sbin"]) {
      mkdirSync(join(tree, dir), { recursive: true });
    }
    copyFileSync(GUEST_BIN, join(tree, "usr/local/bin/tumpel-guest"));
    chmodSync(join(tree, "usr/local/bin/tumpel-guest"), 0o755);
    writeFileSync(join(tree, "usr/local/sbin/tumpel-init"), INIT, { mode: 0o755 });
    writeFileSync(join(tree, "etc/systemd/system/tumpel-guest.service"), UNIT);
    symlinkSync(
      "/etc/systemd/system/tumpel-guest.service",
      join(tree, "etc/systemd/system/multi-user.target.wants/tumpel-guest.service"),
    );
    writeFileSync(join(tree, "etc/tumpel/guest.json"), `${JSON.stringify(recipe.harness, null, 2)}\n`);
    rmSync(join(tree, "etc/resolv.conf"), { force: true });
    writeFileSync(join(tree, "etc/resolv.conf"), "nameserver 1.1.1.1\nnameserver 9.9.9.9\n");
    const components = [...(await installGit(tree)), ...(await recipe.install(tree))];
    run("chmod", ["-R", "u+rwX", tree]);
    const image = join(work, "image.ext4");
    const mib = Math.ceil((treeBytes(tree) * 1.3) / 2 ** 20) + 256;
    run(mkfs, ["-q", "-F", "-d", tree, "-E", "root_owner=0:0", "-L", "rootfs", image, `${mib}M`]);
    ownByRoot(tree, image);
    run(e2fsck, ["-fn", image], { stdio: ["ignore", "ignore", "inherit"] });
    const imageDigest = await sha256(image);
    const kernel = await download(KERNEL);
    copyFileSync(kernel, join(OUT, `${KERNEL.digest}.vmlinux`));
    renameSync(image, join(OUT, `${imageDigest}.ext4`));
    const manifest = GuestImageManifestSchema.parse({
      imageDigest,
      kernelUrl: KERNEL.url,
      kernelDigest: KERNEL.digest,
      baseRootfsUrl: ROOTFS.url,
      baseRootfsDigest: ROOTFS.digest,
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

await main();
