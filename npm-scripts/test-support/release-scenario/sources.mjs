import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export const execute = promisify(execFile);

const checkout = async (root, name, sha) => {
  const dir = join(root, name);
  await execute("git", ["init", "--quiet", dir]);
  await execute("git", ["fetch", "--quiet", "--depth=1", `https://github.com/tumpel/${name}.git`, sha], {
    cwd: dir,
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  await execute("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: dir });
  return dir;
};

const installConvco = async (root) => {
  const platforms = {
    "linux-x64": ["x86_64-unknown-linux-musl", "f9cfad24af372018f4b8d430cf86d1b7b9b36fcb7e1db5dd30c54b2eed7dde75"],
    "linux-arm64": ["aarch64-unknown-linux-musl", "7a4523573a81d24f37aa4d22aa26d8a3083188422213efe0274a7fbbd840c741"],
    "darwin-arm64": ["aarch64-apple-darwin", "cbf86082b5c87254afc333a5353c4b359f09b83488c9250a161cf1caae811884"],
  };
  const platform = `${process.platform}-${process.arch}`;
  assert.ok(
    platforms[platform],
    `The scenario needs a convco 0.7.2 binary for ${platform}. Run it on Linux or Apple Silicon.`,
  );
  const [target, checksum] = platforms[platform];
  const archive = join(root, "convco.tar.gz");
  await execute("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--max-time",
    "30",
    "--output",
    archive,
    `https://github.com/convco/convco/releases/download/v0.7.2/convco-${target}.tar.gz`,
  ]);
  assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), checksum);
  await execute("tar", ["-xzf", archive, "--strip-components=1", `convco-${target}/convco`], { cwd: root });
};

export const scenarioSources = async (root) => {
  const [dashboard, controlPlane] = await Promise.all([
    checkout(root, "dashboard", "a88a5f3a9dec1452de4f57329ba6c008a812f3db"),
    checkout(root, "control-plane", "f2bd4490b649aa9962921672ac10e615f29e8f52"),
    installConvco(root),
  ]);
  return { dashboard, controlPlane, bin: root };
};
