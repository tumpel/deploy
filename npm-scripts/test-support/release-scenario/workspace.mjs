import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hash } from "../../rollout.mjs";
import { serve } from "./services.mjs";

const support = fileURLToPath(new URL(".", import.meta.url));
export const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
export const write = (file, data) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
};
export const read = (file) => JSON.parse(readFileSync(file));
export const download = async (url) =>
  (await exec("curl", ["-fsSL", "--max-time", "30", url], { encoding: "buffer", maxBuffer: 10_000_000 })).stdout;
export const unpack = (cwd, bytes, ...args) =>
  execFileSync("tar", ["-xz", "--strip-components=1", ...args], { cwd, input: bytes, timeout: 30_000 });
export const upstream = async (dir, repo, sha) => {
  const folder = `${repo}-source`;
  unpack(dir, await download(`https://codeload.github.com/tumpel/${repo}/tar.gz/${sha}`), `--one-top-level=${folder}`);
  return join(dir, folder);
};
export const scenario = async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "release-scenario-"));
  const env = {
    PATH: `${dir}:${join(root, "node_modules/.bin")}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: join(dir, "npmrc"),
    GIT_ALLOW_PROTOCOL: "file",
    npm_config_cache: join(dir, "cache"),
    CLOUDFLARE_ACCOUNT_ID: "fixture",
    TUMPEL_ACCOUNT_ID: "fixture",
    CLOUDFLARE_TOFU_TOKEN: "fixture",
    R2_RELEASES_ACCESS_KEY_ID: "fixture",
    R2_RELEASES_SECRET_ACCESS_KEY: "fixture",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_fetch_retries: "0",
    npm_config_update_notifier: "false",
    TMPDIR: join(dir, "scratch"),
    NODE_OPTIONS: `--import=${join(support, "network.mjs")}`,
    SCENARIO_SLEEPS: join(dir, "sleeps"),
  };
  write(
    env.GIT_CONFIG_GLOBAL,
    `[user]\n  name = Release Test\n  email = release@example.test\n[url "${dir}/control-plane.git"]\n  insteadOf = https://github.com/tumpel/control-plane.git\n`,
  );
  mkdirSync(env.TMPDIR);
  symlinkSync(join(support, "edges.mjs"), join(dir, "gh"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 }).trim();
  const cloud = await serve(t, git, dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  env.SCENARIO_URL = cloud.url;
  const run = (cwd, command, args, extraEnv) =>
    exec(command, args, { cwd, env: { ...env, ...extraEnv }, timeout: 60_000 });
  const node = (cwd, script, args = [], extra = {}) =>
    run(cwd, process.execPath, [`npm-scripts/${script}.mjs`, ...args], extra);
  const repo = (name) => {
    const cwd = join(dir, name),
      origin = `${cwd}.git`;
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "clone", "-q", origin, cwd);
    write(join(cwd, ".gitignore"), "node_modules\n.tmp/\ndist/\nrelease/\n");
    return cwd;
  };
  const commit = (cwd, message) => {
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const clients = (protocol) => {
    for (const name of ["cli", "supervisor"]) {
      const asset = name === "cli" ? "tumpel-x86_64-linux" : "tumpel-supervisor-x86_64-linux";
      const cwd = repo(name);
      write(join(cwd, "Cargo.lock"), `[[package]]\nname = "tumpel-api"\nversion = "${protocol}"\n`);
      const sha = commit(cwd, `chore: publish ${name}`);
      git(cwd, "push", "-q", "origin", "main", "HEAD:refs/tags/v1.0.0");
      cloud.check(name, sha, "success");
      const files = [
        [asset, name],
        [`${asset}.sha256`, hash(name)],
      ];
      if (name === "supervisor") {
        const release = {
          supervisorVersion: "1.0.0",
          tumpelApiVersion: protocol,
          channelProtocolOldest: 1,
          channelProtocolVersion: 100,
          guestProtocolOldest: 1,
          guestProtocolVersion: 100,
          binaries: [{ architecture: "Amd64", sha256: hash(name), sizeBytes: name.length }],
        };
        files.push(["release.json", JSON.stringify(release)]);
      }
      cloud.publish(name, "v1.0.0", files);
    }
  };
  const deployRepo = (pins) => {
    const cwd = repo("deploy");
    for (const file of ["npm-scripts", "package.json", "package-lock.json"])
      cpSync(join(root, file), join(cwd, file), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"));
    write(join(cwd, "release-pins.json"), pins);
    commit(cwd, "chore: pin release A");
    git(cwd, "tag", "v1.0.0");
    git(cwd, "push", "-q", "origin", "main", "v1.0.0");
    return cwd;
  };
  return { dir, env, cloud, git, run, node, repo, commit, clients, deployRepo };
};
