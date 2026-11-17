export const CLONE_SECONDS = 120;
export const WORKING_DIRECTORY = "/root/workspace";
export const LTS_NODE_VERSION = "26.13.1";
export const PYTHON_VERSION = "3.15.2";
export const FNM_DIR = "/root/.local/share/fnm";
export const UV_PYTHON_DIR = "/root/.local/share/uv/python";
export const ENVIRONMENT = {
  PATH: `${FNM_DIR}/aliases/default/bin:/root/.cargo/bin:/root/.local/bin:/opt/tumpel/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
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

export const HARNESS_RUNS = {
  ClaudeCode: {
    protocol: "ClaudeStreamJson",
    binary: "claude",
    flags: CLAUDE_FLAGS,
    fixedVariables: [{ name: "DISABLE_AUTOUPDATER", value: "1" }],
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
};
export const TURN_PROTOCOLS = new Set(Object.keys(HARNESS_RUNS));
