#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cached, currentRelease, downloadRelease, fetchVerified } from "./release-download.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? "mvhenten/tumpel";
const CACHE = process.env.TUMPEL_SUPERVISOR_CACHE ?? join(ROOT, ".tmp", "supervisor-release");
const ENDPOINT = process.env.TUMPEL_RELEASE_ENDPOINT ?? "https://api.dev.tumpel.dev";
const OUT = join(ROOT, "target", "debug", "tumpel-supervisor");
const TARGET = "x86_64-unknown-linux-gnu";
const ARCHITECTURE = "Amd64";
const ASSET = `tumpel-supervisor-${TARGET}`;
const TAG = /^supervisor-v(\d+)\.(\d+)\.(\d+)$/;

const die = (message) => {
  console.error(`supervisor-fetch: ${message}`);
  process.exit(1);
};

if (process.arch !== "x64") die(`the released supervisor runs on x64 only and this machine is ${process.arch}`);
const TOKEN =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  die(`no GitHub token to read the releases of ${REPOSITORY}; run with GH_TOKEN="$(gh auth token)"`);

const github = (accept) => ({
  Accept: accept,
  "X-GitHub-Api-Version": "2022-11-28",
  Authorization: `Bearer ${TOKEN}`,
});

const semver = (tag) => tag.match(TAG).slice(1).map(Number);
const newer = (a, b) => {
  const [left, right] = [semver(a.tag_name), semver(b.tag_name)];
  const index = left.findIndex((part, i) => part !== right[i]);
  return index === -1 ? 0 : right[index] - left[index];
};

const latestGithubRelease = async () => {
  const url = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
  const response = await fetch(url, { headers: github("application/vnd.github+json") });
  if (!response.ok) die(`GET ${url} answered ${response.status}: ${await response.text()}`);
  const releases = await response.json();
  return releases.filter((each) => TAG.test(each.tag_name) && !each.draft && !each.prerelease).sort(newer)[0];
};

const fromGithub = async (release) => {
  const asset = release.assets.find((each) => each.name === ASSET);
  const sum = release.assets.find((each) => each.name === `${ASSET}.sha256`);
  if (!asset || !sum)
    die(`GitHub release ${release.tag_name} lacks ${ASSET} or ${ASSET}.sha256; attach both to the release by hand`);
  const response = await fetch(sum.url, { headers: github("application/octet-stream") });
  if (!response.ok) die(`GET ${sum.url} answered ${response.status}: ${await response.text()}`);
  const digest = (await response.text()).split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) die(`${sum.name} on ${release.tag_name} holds no sha256; attach it again`);
  const path = join(CACHE, release.tag_name, ASSET);
  if (!cached(path, digest))
    await fetchVerified(
      asset.url,
      digest,
      path,
      `${ASSET} on ${release.tag_name} does not match its .sha256; attach both again`,
      github("application/octet-stream"),
    ).catch((error) => die(error.message));
  return { version: release.tag_name, source: `GitHub release ${release.tag_name}`, path, digest };
};

const fromCurrent = async () => {
  const release = await currentRelease(ENDPOINT, "dev").catch((error) => die(error.message));
  const path = await downloadRelease({
    endpoint: ENDPOINT,
    stage: "dev",
    release,
    kind: "supervisor",
    entries: release.supervisors,
    architecture: ARCHITECTURE,
    dir: join(CACHE, release.releaseVersion),
  }).catch((error) => die(error.message));
  const digest = release.supervisors.find((each) => each.architecture === ARCHITECTURE).sha256;
  return { version: release.releaseVersion, source: `${ENDPOINT}/v1/releases/current`, path, digest };
};

const latest = await latestGithubRelease();
const supervisor = latest ? await fromGithub(latest) : await fromCurrent();
mkdirSync(dirname(OUT), { recursive: true });
copyFileSync(supervisor.path, OUT);
chmodSync(OUT, 0o755);
console.log(
  `tumpel-supervisor ${supervisor.version} from ${supervisor.source}, sha256 ${supervisor.digest}, at ${OUT}`,
);
