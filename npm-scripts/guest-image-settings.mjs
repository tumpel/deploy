import { controlPlaneModule } from "./control-plane-source.mjs";

const { GUEST_TOOLCHAINS } = await controlPlaneModule("packages/control-plane/src/guest-toolchains.ts");
const { HARNESS_CATALOG } = await controlPlaneModule("packages/control-plane/src/harness-catalog.ts");

export const CLONE_SECONDS = 120;
export const WORKING_DIRECTORY = "/root/workspace";
export const LTS_NODE_VERSION = GUEST_TOOLCHAINS.Node;
export const PYTHON_VERSION = GUEST_TOOLCHAINS.Python;
export const RUST_VERSION = GUEST_TOOLCHAINS.Rust;
export const FNM_DIR = "/root/.local/share/fnm";
export const UV_PYTHON_DIR = "/root/.local/share/uv/python";
export const ENVIRONMENT = {
  PATH: `${FNM_DIR}/aliases/default/bin:/root/.cargo/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  HOME: "/root",
  LANG: "C.UTF-8",
};
export const CARGO_BUILD_CONFIG = `#!/bin/sh
set -eu
config=$1
if [ -e "$config" ]; then
  exit 0
fi
memory_kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
jobs=$((memory_kib / 1572864))
if [ "$jobs" -lt 1 ]; then
  jobs=1
fi
cpus=$(nproc)
if [ "$jobs" -gt "$cpus" ]; then
  jobs=$cpus
fi
tmp=$(mktemp "$config.XXXXXX")
printf '[build]\njobs = %s\n' "$jobs" > "$tmp"
mv "$tmp" "$config"
`;
export const CLAUDE_FLAGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--dangerously-skip-permissions",
  "--settings",
  JSON.stringify({ permissions: { deny: ["Agent", "Monitor"] } }),
];
export const NODE_ARCH = { amd64: "x64", arm64: "arm64" };

const codexCredentialVariables = () => [
  ...new Set(
    HARNESS_CATALOG.filter((entry) => entry.harness === "Codex").flatMap((entry) =>
      entry.credentials.map((credential) => credential.variable),
    ),
  ),
];
export const CODEX_FLAGS = [
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
  "-c",
  "check_for_update_on_startup=false",
  "-c",
  "features.shell_snapshot=false",
  ...["apps", "connectors", "plugins", "remote_plugin"].flatMap((feature) => ["-c", `features.${feature}=false`]),
  "-c",
  "shell_environment_policy.ignore_default_excludes=true",
  "-c",
  `shell_environment_policy.exclude=${JSON.stringify(codexCredentialVariables())}`,
];

export const HARNESS_RUNS = {
  ClaudeCode: {
    protocol: "ClaudeStreamJson",
    binary: "claude",
    flags: CLAUDE_FLAGS,
    fixedVariables: [
      { name: "DISABLE_AUTOUPDATER", value: "1" },
      { name: "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", value: "1" },
    ],
  },
  Codex: {
    protocol: "CodexExecJson",
    binary: "codex",
    flags: CODEX_FLAGS,
    fixedVariables: [],
  },
  PiDev: {
    protocol: "PiRpc",
    binary: "pi",
    flags: ["--mode", "rpc"],
    fixedVariables: [{ name: "PI_SKIP_VERSION_CHECK", value: "1" }],
  },
  OpenCode: {
    protocol: "PromptOnStdin",
    binary: "opencode",
    flags: ["run", "--format", "json", "--auto"],
    fixedVariables: [{ name: "OPENCODE_DISABLE_AUTOUPDATE", value: "1" }],
  },
  Gemini: {
    protocol: "GeminiStreamJson",
    binary: "gemini.js",
    flags: ["--skip-trust", "--output-format", "stream-json", "--approval-mode", "yolo"],
    fixedVariables: [],
  },
};
export const TURN_PROTOCOLS = new Set(Object.keys(HARNESS_RUNS));
