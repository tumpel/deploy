import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TOFU_VERSION = "1.13.2";
export const INFRA_REPOSITORY = "https://github.com/tumpel/infra.git";
export const CONTROL_PLANE_REPOSITORY = "https://github.com/tumpel/control-plane.git";

export const readPin = (name) => JSON.parse(readFileSync(new URL(`../pins/${name}.json`, import.meta.url), "utf8"));

const run = (command, args, cwd, die) => {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"], timeout: 600_000 });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status}`);
};

export const pinnedCommit = (name) => {
  const { commit } = readPin(name);
  if (!/^[0-9a-f]{40}$/.test(String(commit))) throw new Error(`pins/${name}.json needs a 40-character commit SHA`);
  return commit;
};

export const checkoutPinned = (repository, pin, dir, die) => {
  if (existsSync(dir)) return dir;
  const staging = `${dir}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  run("git", ["init", "--quiet"], staging, die);
  run("git", ["fetch", "--quiet", "--depth", "1", repository, pin], staging, die);
  run("git", ["checkout", "--quiet", "FETCH_HEAD"], staging, die);
  renameSync(staging, dir);
  return dir;
};

export const installTofu = async (dir, die) => {
  const binary = join(dir, "tofu");
  if (existsSync(binary)) return binary;
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch] ?? die(`no OpenTofu build for ${process.arch}`);
  const base = `https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}`;
  const archive = `tofu_${TOFU_VERSION}_linux_${arch}.tar.gz`;
  const download = async (name) => {
    const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) die(`downloading ${name} returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const [tarball, sums] = await Promise.all([download(archive), download(`tofu_${TOFU_VERSION}_SHA256SUMS`)]);
  const expected = sums
    .toString("utf8")
    .split("\n")
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(" ")[0];
  if (!expected || expected !== createHash("sha256").update(tarball).digest("hex"))
    die(`${archive} does not match its published SHA256 sum`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, archive), tarball);
  run("tar", ["-xzf", archive, "tofu"], dir, die);
  chmodSync(binary, 0o755);
  return binary;
};

export const readHandoff = async ({ stage, accountId, token }, die) => {
  const object = `infra-outputs-${stage}.json`;
  const path = `/accounts/${accountId}/r2/buckets/tumpel-builder-secrets/objects/${encodeURIComponent(object)}`;
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) die(`tumpel-builder-secrets holds no ${object}; apply the infra of ${stage} first`);
  if (!response.ok) die(`GET ${path} returned ${response.status}; the token needs Workers R2 Storage Read`);
  return response.json();
};
