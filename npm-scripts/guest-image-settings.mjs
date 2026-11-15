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

export const HARNESS_RUNS = {
  ClaudeCode: {
    protocol: "ClaudeStreamJson",
    binary: "claude",
    flags: CLAUDE_FLAGS,
  },
  PiDev: {
    protocol: "PiRpc",
    binary: "pi",
    flags: ["--mode", "rpc"],
    stripComponents: 1,
  },
  OpenCode: {
    protocol: "PromptOnStdin",
    binary: "opencode",
    flags: ["run", "--format", "json", "--auto"],
    stripComponents: 0,
  },
};
export const TURN_PROTOCOLS = new Set(Object.keys(HARNESS_RUNS));
