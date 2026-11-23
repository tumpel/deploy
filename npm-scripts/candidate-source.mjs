import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_ARCHITECTURES } from "./release-architectures.mjs";
import { cliAsset, releaseAssetUrl, supervisorAsset } from "./release-download.mjs";
import { freezeCandidate, hash } from "./rollout.mjs";

export const fetched = async (url, transport = fetch) => {
  const response = await transport(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${url} failed (${response.status}); fix the source before releasing.`);
  return response;
};

export const github = async (path) => (await fetched(`https://api.github.com${path}`)).json();

export const dashboardFiles = (bytes) => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-release-"));
  const path = join(dir, "dashboard.tgz");
  writeFileSync(path, bytes);
  try {
    return execFileSync("tar", ["-tzf", path], { encoding: "utf8", timeout: 30_000 })
      .trim()
      .split("\n")
      .filter((name) => name.startsWith("package/dist/") && !name.endsWith("/"))
      .map((name) => ({
        path: name.slice("package/dist/".length),
        sha256: hash(execFileSync("tar", ["-xOf", path, name], { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 })),
      }));
  } finally {
    rmSync(dir, { recursive: true });
  }
};

export const candidateSource = async ({ pins, stage, github, clock = { now: Date.now }, transport = fetch }) => {
  const source = async (path) =>
    Buffer.from(
      (await github(`/repos/tumpel/control-plane/contents/${path}?ref=${pins.controlPlane}`)).content,
      "base64",
    ).toString();
  const controlPlane = JSON.parse(await source("packages/control-plane/package.json"));
  const site = JSON.parse(await source("packages/dashboard-site/package.json"));
  const protocol = /\/v([^/]+)\//.exec(controlPlane.dependencies["@tumpel/schemas"])?.[1];
  const url = site.dependencies["@tumpel/dashboard"];
  const dashboardVersion = /\/v([^/]+)\//.exec(url)?.[1];
  if (!dashboardVersion || !controlPlane.dependencies["@tumpel/pages"].includes(`/v${dashboardVersion}/`))
    throw new Error("Dashboard and pages do not name one release; merge their dependency update before assembly.");
  const dashboardRelease = await github(`/repos/tumpel/dashboard/releases/tags/v${dashboardVersion}`);
  if (dashboardRelease.draft || dashboardRelease.tag_name !== `v${dashboardVersion}`)
    throw new Error("The dashboard candidate is not published.");
  const { sha: dashboardSha } = await github(`/repos/tumpel/dashboard/commits/v${dashboardVersion}`);
  const clients = {};
  for (const name of ["cli", "supervisor"]) {
    const repo = `tumpel/${name}`;
    const release = await github(`/repos/${repo}/releases/tags/v${pins[name]}`);
    if (release.draft || release.tag_name !== `v${pins[name]}`)
      throw new Error(`${repo} is not published at the intended version.`);
    const { sha } = await github(`/repos/${repo}/commits/v${pins[name]}`);
    const lock = Buffer.from(
      (await github(`/repos/${repo}/contents/Cargo.lock?ref=${sha}`)).content,
      "base64",
    ).toString();
    const builtProtocol = /\[\[package\]\]\s+name = "tumpel-api"\s+version = "([^"]+)"/.exec(lock)?.[1];
    if (builtProtocol !== protocol)
      throw new Error(`${repo} does not pin protocol ${protocol}; publish the required client first.`);
    const binaries = [];
    for (const arch of RELEASE_ARCHITECTURES) {
      const architecture = arch === "amd64" ? "Amd64" : "Arm64";
      const asset = name === "cli" ? cliAsset(architecture) : supervisorAsset(architecture);
      const url = releaseAssetUrl(repo, pins[name], asset);
      const sha256 = (await (await fetched(`${url}.sha256`, transport)).text()).split(/\s+/)[0];
      binaries.push({ architecture, sha256 });
    }
    clients[name] = { version: pins[name], sha, protocol: builtProtocol, binaries };
  }
  const bytes = Buffer.from(await (await fetched(url, transport)).arrayBuffer());
  const expected = (await (await fetched(`${url}.sha256`, transport)).text()).split(/\s+/)[0];
  if (hash(bytes) !== expected) throw new Error("Dashboard tarball checksum failed; keep main pins unchanged.");
  return freezeCandidate({
    stage,
    createdAt: clock.now(),
    pins,
    protocol,
    clients,
    dashboard: { version: dashboardVersion, sha: dashboardSha, url, sha256: expected, files: dashboardFiles(bytes) },
  });
};
