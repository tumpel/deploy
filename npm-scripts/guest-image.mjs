#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseImageManifestSchema, BaseLayout, GuestHarnessSchema, GuestImageManifestSchema } from "@tumpel/schemas";
import {
  ENVIRONMENT,
  FNM_DIR,
  LTS_NODE_VERSION,
  NODE_ARCH,
  PYTHON_VERSION,
  UV_PYTHON_DIR,
  WORKING_DIRECTORY,
} from "./guest-image-settings.mjs";
import { UBUNTU_PACKAGES } from "./guest-packages.mjs";
import { extractArchive, layerHarnesses, layerRecipe } from "./harness-recipes.mjs";
import { disabledReason, RELEASE_ARCHITECTURES } from "./release-architectures.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.TUMPEL_IMAGE_DIR ?? join(homedir(), "development", ".tmp", "tumpel-images");
const FIRECRACKER_CI = "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261111-778a26c0594c-0";
const LAUNCHPAD = "https://launchpad.net/ubuntu/+archive/primary/+files";
const GIT_VERSION = "2.43.0-1ubuntu7.4";
const LIBCURL_VERSION = "8.5.0-2ubuntu10.16";
const GH_VERSION = "2.103.3";
const FNM_VERSION = "1.39.0";
const UV_VERSION = "0.13.8";
const RUSTUP_VERSION = "1.29.3";
const RUST_VERSION = "1.100.0";
const RUST_CHANNEL_DIGEST = "3051e859570f64a8c5acb9d09e87425db52c7d97287c67e8f6d57d7d34ef9258";
const PYTHON_BUILD = "20261110";
const NODE_HOME = "/opt/tumpel/node";
const RUST_COMPONENTS = ["clippy", "rustfmt"];

const PINS = {
  amd64: {
    target: "x86_64-unknown-linux-gnu",
    kernel: "0ee1eb9074bfe4d90b3a6c0d3ea9c7c7b8c7563e69796fd73e7801db83a67b9f",
    rootfs: "f84ec1241d88414f43c417319fbaa31751d1cf4298f127b004c0bee8d95885c8",
    git: "c79b7948ef9860c97ec74293a90178676e63368a0711c95c28a55af4edf1adab",
    libcurl: "f3993897876cd03ea10941c9b364965ff95d0226459f31f6c5f5b93562c80798",
    gh: "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
    ltsNode: "5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864",
    fnm: "7807664f39d39fc518da1c35ba0181e4b3267603c4b1dedeb4b5fc6ae440a224",
    uv: "5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91",
    rustup: "b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55",
    python: "ad23d1b73fac26440b0306ae06911031344c49a90ec19716c8362e7fa40cae43",
  },
  arm64: {
    target: "aarch64-unknown-linux-gnu",
    kernel: "36640239c15df144c9defef7a74053413053de21469368e99472124e515ced80",
    rootfs: "fc6e9a413344b9ab7e3415598988a9a4a7fd8bd62fc49cf8ce5225ca3b7039b9",
    git: "b46ef5ad7292f8ae69a7ec18c05e5b40f6c1fca837df2ce4b05b05bd46c9dc2b",
    libcurl: "057490ffc9901df7fe09913e381442fc7615bb972a1dc4198e38bcf840447e77",
    gh: "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63",
    ltsNode: "89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd",
    fnm: "4eaff58b2c5bf30d0934027572dd0b5bbb60d2a1af309230b53662d4b1d45599",
    uv: "74f2f5c6024d397481db228db8fc25eed420db192243f88438c118e7e013e585",
    rustup: "9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282",
    python: "d1367a6c3cd86a9e35712072841f1376859f3b47a2a54e224421a0f9fd169047",
  },
};
const FIRECRACKER_ARCH = { amd64: "x86_64", arm64: "aarch64" };
const FNM_ASSET = { amd64: "fnm-linux", arm64: "fnm-arm64" };
const HOST_ARCH = { x64: "amd64", arm64: "arm64" };

const pinsFor = (arch) => {
  const pins = PINS[arch];
  const ci = `${FIRECRACKER_CI}/${FIRECRACKER_ARCH[arch]}`;
  return {
    arch,
    target: pins.target,
    guestBin: process.env.TUMPEL_GUEST_BIN ?? join(ROOT, ".tmp", "release-binaries", "tumpel-guest"),
    kernel: { url: `${ci}/vmlinux-6.18.62`, digest: pins.kernel },
    rootfs: { url: `${ci}/ubuntu-24.04.squashfs`, digest: pins.rootfs },
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
    ltsNode: {
      name: "node",
      version: LTS_NODE_VERSION,
      url: `https://nodejs.org/dist/v${LTS_NODE_VERSION}/node-v${LTS_NODE_VERSION}-linux-${NODE_ARCH[arch]}.tar.xz`,
      digest: pins.ltsNode,
    },
    fnm: {
      name: "fnm",
      version: FNM_VERSION,
      url: `https://github.com/Schniz/fnm/releases/download/v${FNM_VERSION}/${FNM_ASSET[arch]}.zip`,
      digest: pins.fnm,
    },
    uv: {
      name: "uv",
      version: UV_VERSION,
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${pins.target}.tar.gz`,
      digest: pins.uv,
    },
    rustup: {
      name: "rustup",
      version: RUSTUP_VERSION,
      url: `https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${pins.target}/rustup-init`,
      digest: pins.rustup,
    },
    rust: {
      name: "rust",
      version: RUST_VERSION,
      url: `https://static.rust-lang.org/dist/channel-rust-${RUST_VERSION}.toml`,
      digest: RUST_CHANNEL_DIGEST,
    },
    python: {
      name: "cpython",
      version: PYTHON_VERSION,
      url: `https://releases.astral.sh/github/python-build-standalone/releases/download/${PYTHON_BUILD}/cpython-${PYTHON_VERSION}%2B${PYTHON_BUILD}-${pins.target}-install_only_stripped.tar.gz`,
      digest: pins.python,
    },
    packages: UBUNTU_PACKAGES[arch].map(([file, digest]) => {
      const [name, version] = file.split("_");
      return { name, version, url: `${LAUNCHPAD}/${file}`, digest };
    }),
  };
};
const OCI_TAG = "rootfs";

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

const STUB_INIT = `#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
fail() {
  echo "tumpel-init: $1 failed: $2" >&2
  exit 1
}
mountpoint -q /proc || mount -t proc proc /proc || fail proc "mounting /proc"
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev || fail dev "mounting /dev"
output=$(mount -t squashfs -o ro /dev/vdc /opt/tumpel/guest 2>&1) || fail guest "$output"
[ -x /opt/tumpel/guest/init ] || fail guest "the guest drive on /dev/vdc has no init"
exec /opt/tumpel/guest/init
`;

const UNIT = `[Unit]
Description=tumpel guest agent
DefaultDependencies=no
After=local-fs.target

[Service]
ExecStart=/usr/local/bin/tumpel-guest
Restart=always
RestartSec=1
Delegate=yes
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

const HARNESS_PREFIX = "/opt/tumpel/harness";

const withBinary = (harness, binary) =>
  GuestHarnessSchema.parse({ ...harness, command: [binary, ...harness.command.slice(1)] });

const recipeFor = (name, pins) => {
  const { harness, install } = layerRecipe(name, pins.arch);
  if (install.kind === "None") return { harness, install: async () => [] };
  if (install.kind === "Archive") {
    const component = { name: install.binary, version: install.version, url: install.url, digest: install.digest };
    return {
      harness: withBinary(harness, `${HARNESS_PREFIX}/bin/${install.binary}`),
      install: async (tree) => {
        const bin = join(tree, HARNESS_PREFIX, "bin");
        mkdirSync(bin, { recursive: true });
        extractArchive(await download(component), bin, install);
        return [component];
      },
    };
  }
  const binary = `${HARNESS_PREFIX}/node_modules/${install.package}/${install.binary}`;
  return {
    harness: withBinary(harness, binary),
    install: async (tree) => {
      const prefix = join(tree, HARNESS_PREFIX);
      mkdirSync(prefix, { recursive: true });
      run(
        process.execPath,
        [
          join(tree, NODE_HOME, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
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
        ],
        { env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } },
      );
      const installed = join(tree, binary);
      if (!existsSync(installed))
        die(`npm installed no ${installed}; check that ${install.package}@${install.version} is published`);
      chmodSync(installed, 0o755);
      return [];
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

const packOci = (rootfs, layout, config, arch) => {
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
    config.workingDirectory,
    ...Object.entries(config.environment).flatMap(([name, value]) => ["--config.env", `${name}=${value}`]),
  ]);
  run(umoci, ["raw", "add-layer", "--image", image, "--history.created_by", config.createdBy, rootfs]);
  run(umoci, ["gc", "--layout", layout]);
};

const unpackRootfs = async (tree, pins) => {
  run(tool("unsquashfs"), ["-no-xattrs", "-ignore-errors", "-q", "-n", "-d", tree, await download(pins.rootfs)], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (const dir of ["mnt", "rom", "overlay", "opt", "etc/tumpel", "usr/local/bin", "usr/local/sbin"]) {
    mkdirSync(join(tree, dir), { recursive: true });
  }
};

const hostPins = () => {
  const arch = HOST_ARCH[process.arch];
  if (!PINS[arch]) die(`no pins for the build machine architecture ${process.arch}; build images on amd64 or arm64`);
  return pinsFor(arch);
};

const installPackages = async (tree, pins) => {
  const dpkgDeb = tool("dpkg-deb");
  for (const deb of pins.packages) run(dpkgDeb, ["-x", await download(deb), tree]);
  for (const [link, target] of [
    ["cc", "gcc"],
    ["c++", "g++"],
    ["fd", "fdfind"],
  ])
    symlinkSync(target, join(tree, "usr/bin", link));
  return pins.packages;
};

const installNodeManager = async (tree, pins) => {
  const installation = `${FNM_DIR}/node-versions/v${LTS_NODE_VERSION}/installation`;
  mkdirSync(join(tree, installation), { recursive: true });
  run("tar", [
    "-xJf",
    await download(pins.ltsNode),
    "-C",
    join(tree, installation),
    "--strip-components=1",
    "--no-same-owner",
  ]);
  mkdirSync(join(tree, FNM_DIR, "aliases"), { recursive: true });
  symlinkSync(installation, join(tree, FNM_DIR, "aliases", "default"));
  run("cp", ["-al", join(tree, installation), join(tree, NODE_HOME)]);
  const bin = join(tree, "root/.local/bin");
  mkdirSync(bin, { recursive: true });
  run(tool("unzip"), ["-q", "-o", await download(pins.fnm), "fnm", "-d", bin]);
  chmodSync(join(bin, "fnm"), 0o755);
  return [pins.ltsNode, pins.fnm];
};

const installPython = async (tree, pins, host, work) => {
  const bin = join(tree, "root/.local/bin");
  mkdirSync(bin, { recursive: true });
  run("tar", ["-xzf", await download(pins.uv), "-C", bin, "--strip-components=1", "--no-same-owner"]);
  const runner = join(work, "uv");
  mkdirSync(runner, { recursive: true });
  run("tar", ["-xzf", await download(host.uv), "-C", runner, "--strip-components=1", "--no-same-owner"]);
  const key = `cpython-${PYTHON_VERSION}-linux-${FIRECRACKER_ARCH[pins.arch]}-gnu`;
  run(join(runner, "uv"), ["python", "install", "--no-bin", "--install-dir", join(tree, UV_PYTHON_DIR), key], {
    env: { ...process.env, UV_NO_CONFIG: "1", UV_CACHE_DIR: join(work, "uv-cache") },
  });
  const minor = PYTHON_VERSION.split(".").slice(0, 2).join(".");
  const python = `${UV_PYTHON_DIR}/${key}/bin/python${minor}`;
  if (!existsSync(join(tree, python))) die(`uv installed no ${python}; check PYTHON_VERSION against uv ${UV_VERSION}`);
  for (const name of [`python${minor}`, "python3", "python"]) symlinkSync(python, join(bin, name));
  return [pins.uv, pins.python];
};

const installRust = async (tree, pins, host, work) => {
  const cargoHome = join(tree, "root/.cargo");
  const rustupHome = join(tree, "root/.rustup");
  const runner = join(work, "rustup-init");
  copyFileSync(await download(host.rustup), runner);
  chmodSync(runner, 0o755);
  const { RUSTUP_TOOLCHAIN, ...environment } = process.env;
  run(
    runner,
    [
      "-y",
      "--no-modify-path",
      "--profile",
      "minimal",
      "--default-toolchain",
      RUST_VERSION,
      "--component",
      RUST_COMPONENTS.join(","),
      "--default-host",
      pins.target,
    ],
    { env: { ...environment, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome } },
  );
  const bin = join(cargoHome, "bin");
  const proxies = readdirSync(bin);
  for (const name of proxies) rmSync(join(bin, name));
  copyFileSync(await download(pins.rustup), join(bin, "rustup"));
  chmodSync(join(bin, "rustup"), 0o755);
  for (const name of proxies.filter((name) => name !== "rustup")) linkSync(join(bin, "rustup"), join(bin, name));
  for (const name of readdirSync(cargoHome).filter((name) => name.startsWith("env"))) {
    const path = join(cargoHome, name);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll(tree, ""));
  }
  for (const dir of ["downloads", "tmp"]) rmSync(join(rustupHome, dir), { recursive: true, force: true });
  return [pins.rustup, pins.rust];
};

const relinkIntoGuest = (tree, dir) => {
  const links = run("find", [join(tree, dir), "-type", "l", "-lname", `${tree}/*`], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  for (const link of links.stdout.toString().split("\n").filter(Boolean)) {
    const target = readlinkSync(link).slice(tree.length);
    rmSync(link);
    symlinkSync(target, link);
  }
};

const installDevTools = async (tree, pins, work) => {
  mkdirSync(join(tree, "opt/tumpel"), { recursive: true });
  copyFileSync(join(ROOT, "npm-scripts/prebuild.mjs"), join(tree, "opt/tumpel/prebuild.mjs"));
  chmodSync(join(tree, "opt/tumpel/prebuild.mjs"), 0o755);
  rmSync(join(tree, "etc/resolv.conf"), { force: true });
  writeFileSync(join(tree, "etc/resolv.conf"), "nameserver 1.1.1.1\nnameserver 9.9.9.9\n");
  const host = hostPins();
  const components = [
    ...(await installGit(tree, pins)),
    ...(await installPackages(tree, pins)),
    ...(await installNodeManager(tree, pins)),
    ...(await installPython(tree, pins, host, work)),
    ...(await installRust(tree, pins, host, work)),
  ];
  relinkIntoGuest(tree, "root");
  return components;
};

const packImage = async (work, tree, pins, out, ociConfig) => {
  const [mkfs, e2fsck] = [tool("mkfs.ext4"), tool("e2fsck")];
  run("chmod", ["-R", "u+rwX", tree]);
  const image = join(work, "image.ext4");
  const mib = Math.ceil((treeBytes(tree) * 1.3) / 2 ** 20) + 256;
  run(mkfs, ["-q", "-F", "-d", tree, "-E", "root_owner=0:0", "-L", "rootfs", image, `${mib}M`]);
  ownByRoot(tree, image);
  run(e2fsck, ["-fn", image], { stdio: ["ignore", "ignore", "inherit"] });
  const imageDigest = await sha256(image);
  const kernel = await download(pins.kernel);
  copyFileSync(kernel, join(out, `${pins.kernel.digest}.vmlinux`));
  renameSync(image, join(out, `${imageDigest}.ext4`));
  const rootfs = join(out, `${imageDigest}.rootfs.tar`);
  run("tar", ["-C", tree, "--sort=name", "--numeric-owner", "--owner=0", "--group=0", "-cf", rootfs, "."]);
  packOci(rootfs, join(out, `oci-${imageDigest}`), ociConfig, pins.arch);
  return imageDigest;
};

const buildBase = async (pins) => {
  const out = join(OUT, "base");
  const work = join(OUT, `.build-${process.pid}`);
  const tree = join(work, "tree");
  mkdirSync(work, { recursive: true });
  mkdirSync(out, { recursive: true });
  try {
    await unpackRootfs(tree, pins);
    for (const dir of ["opt/harness", "opt/tumpel/guest"]) mkdirSync(join(tree, dir), { recursive: true });
    writeFileSync(join(tree, "usr/local/sbin/tumpel-init"), STUB_INIT, { mode: 0o755 });
    writeFileSync(join(tree, "etc/tumpel/base-layout"), `${BaseLayout.Version}\n`);
    const components = await installDevTools(tree, pins, work);
    const imageDigest = await packImage(work, tree, pins, out, {
      workingDirectory: WORKING_DIRECTORY,
      environment: ENVIRONMENT,
      createdBy: `tumpel guest:image base ${BaseLayout.Version}`,
    });
    const manifest = BaseImageManifestSchema.parse({
      imageDigest,
      kernelUrl: pins.kernel.url,
      kernelDigest: pins.kernel.digest,
      baseRootfsUrl: pins.rootfs.url,
      baseRootfsDigest: pins.rootfs.digest,
      baseLayoutVersion: BaseLayout.Version,
      components,
    });
    const manifestPath = join(out, `${imageDigest}.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(manifestPath);
  } finally {
    run("chmod", ["-R", "u+w", work]);
    rmSync(work, { recursive: true, force: true });
  }
};

const buildImage = async (name, pins) => {
  const recipe = recipeFor(name, pins);
  const work = join(OUT, `.build-${process.pid}`);
  const tree = join(work, "tree");
  mkdirSync(work, { recursive: true });
  try {
    await unpackRootfs(tree, pins);
    copyFileSync(pins.guestBin, join(tree, "usr/local/bin/tumpel-guest"));
    chmodSync(join(tree, "usr/local/bin/tumpel-guest"), 0o755);
    writeFileSync(join(tree, "usr/local/sbin/tumpel-init"), INIT, { mode: 0o755 });
    writeFileSync(join(tree, "etc/systemd/system/tumpel-guest.service"), UNIT);
    symlinkSync(
      "/etc/systemd/system/tumpel-guest.service",
      join(tree, "etc/systemd/system/multi-user.target.wants/tumpel-guest.service"),
    );
    writeFileSync(join(tree, "etc/tumpel/guest.json"), `${JSON.stringify(recipe.harness, null, 2)}\n`);
    const components = [...(await installDevTools(tree, pins, work)), ...(await recipe.install(tree))];
    const imageDigest = await packImage(work, tree, pins, OUT, {
      workingDirectory: recipe.harness.workingDirectory,
      environment: recipe.harness.environment,
      createdBy: `tumpel guest:image ${recipe.harness.harness} ${recipe.harness.harnessVersion}`,
    });
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
      `pass a harness and optionally an architecture: npm run guest:image -- <base|${layerHarnesses().join("|")}|all> [amd64|arm64]`,
    );
  if (!PINS[arch]) die(`no pins for architecture ${arch}; pass amd64 or arm64`);
  if (!RELEASE_ARCHITECTURES.includes(arch)) die(disabledReason(arch));
  const pins = pinsFor(arch);
  if (name === "base") {
    await buildBase(pins);
    return;
  }
  if (!existsSync(pins.guestBin))
    die(
      `${pins.guestBin} is missing; fetch the pinned guest with npm run release:fetch -- guest, or set TUMPEL_GUEST_BIN to a tumpel-guest binary`,
    );
  for (const harness of name === "all" ? layerHarnesses() : [name]) await buildImage(harness, pins);
};

await main();
