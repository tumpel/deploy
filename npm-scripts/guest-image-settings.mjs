export const CLONE_SECONDS = 120;
export const WORKING_DIRECTORY = "/root/workspace";
export const ENVIRONMENT = {
  PATH: "/opt/tumpel/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
};
export const CLAUDE_FLAGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--dangerously-skip-permissions",
];
export const NODE_ARCH = { amd64: "x64", arm64: "arm64" };

const PI_VERSION = "1.5.2";

export const HARNESS_RUNS = {
  ClaudeCode: { protocol: "ClaudeStreamJson", binary: "claude", flags: CLAUDE_FLAGS },
  PiDev: {
    protocol: "ClaudeStreamJson",
    binary: "pi",
    flags: ["--mode", "rpc"],
    archive: {
      version: PI_VERSION,
      url: (arch) =>
        `https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-linux-${NODE_ARCH[arch]}.tar.gz`,
      digests: {
        amd64: "811c6f2c9e7aaee252b5404252e556fb713aa209c1f7f924226aa77d4ef70cb5",
        arm64: "42805cd5615952fcbbfc9c56b04f8feb84395134952e169a6cdc8d7676975666",
      },
      stripComponents: 1,
    },
  },
};
export const TURN_PROTOCOLS = new Set(Object.keys(HARNESS_RUNS));

export const harnessArchive = (entry, arch) => {
  const { archive, binary } = HARNESS_RUNS[entry.harness];
  if (archive.version !== entry.harnessVersion)
    throw new Error(
      `the ${entry.harness} archive pin is ${archive.version}, the catalog names ${entry.harnessVersion}; make them match`,
    );
  return {
    name: binary,
    version: archive.version,
    url: archive.url(arch),
    digest: archive.digests[arch],
    stripComponents: archive.stripComponents,
  };
};
