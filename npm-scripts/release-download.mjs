import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReleaseManifestSchema, SupervisorReleaseSchema } from "@tumpel/schemas";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PINS_PATH = join(ROOT, "release-pins.json");
export const RELEASE_CACHE = process.env.TUMPEL_RELEASE_CACHE ?? join(ROOT, ".tmp", "releases");
const VERSION = /^\d+\.\d+\.\d+$/;
const DEV_BUILD = /^\d+\.\d+\.\d+-main\.\d+$/;

export const SUPERVISOR_REPOSITORY = "tumpel/supervisor";
export const CLI_REPOSITORY = "tumpel/cli";

const MACHINES = { Amd64: "x86_64", Arm64: "aarch64" };

export const supervisorAsset = (architecture) => `tumpel-supervisor-${MACHINES[architecture]}-linux`;

export const guestAsset = (architecture) => `tumpel-guest-${MACHINES[architecture]}-linux`;

export const cliAsset = (architecture) => `tumpel-${MACHINES[architecture]}-linux`;

export const releaseAssetUrl = (repository, version, asset) =>
  `https://github.com/${repository}/releases/download/v${version}/${asset}`;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const currentRelease = async (endpoint, stage) => {
  const url = `${endpoint}/v1/releases/current`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`GET ${url} answered ${response.status}: ${await response.text()}; publish a release to ${stage}`);
  const parsed = ReleaseManifestSchema.safeParse(await response.json());
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(
    `GET ${url} answered a release this checkout cannot read (${issues}); ${stage} has not published a release with downloadUrl yet, so merge to main or push a v* tag to publish one, then try again`,
  );
};

export const cached = (path, digest) => existsSync(path) && sha256(readFileSync(path)) === digest;

export const fetchVerified = async (url, digest, path, fix, headers = {}) => {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}: ${await response.text()}`);
  const body = Buffer.from(await response.arrayBuffer());
  const actual = sha256(body);
  if (actual !== digest) throw new Error(`GET ${url} returned sha256 ${actual}, expected ${digest}; ${fix}`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  return path;
};

export const downloadRelease = async ({ endpoint, stage, release, kind, entries, architecture, dir }) => {
  const entry = entries.find((each) => each.architecture === architecture);
  if (!entry) throw new Error(`release ${release.releaseVersion} on ${stage} carries no ${kind} for ${architecture}`);
  const path = join(dir, `${kind}-${architecture.toLowerCase()}-${entry.sha256}`);
  if (cached(path, entry.sha256)) return path;
  return fetchVerified(
    `${endpoint}/v1/releases/${kind}/${architecture}`,
    entry.sha256,
    path,
    `release ${release.releaseVersion} names ${entry.sha256}; publish the release again with the release workflow`,
  );
};

export const checkedPins = (pins, stage) => {
  if (!VERSION.test(String(pins.cli)))
    throw new Error(`${PINS_PATH} names cli ${pins.cli}, not X.Y.Z; pin a released version of tumpel/cli`);
  if (VERSION.test(String(pins.supervisor))) return { supervisor: pins.supervisor, cli: pins.cli };
  if (!DEV_BUILD.test(String(pins.supervisor)))
    throw new Error(
      `${PINS_PATH} names supervisor ${pins.supervisor}, not X.Y.Z or X.Y.Z-main.N; pin a release of tumpel/supervisor`,
    );
  if (stage !== "dev")
    throw new Error(
      `${PINS_PATH} names the supervisor dev build ${pins.supervisor}, and only stage dev runs dev builds; pin a stable X.Y.Z for ${stage}`,
    );
  return { supervisor: pins.supervisor, cli: pins.cli };
};

export const releasePins = () =>
  checkedPins(JSON.parse(readFileSync(PINS_PATH, "utf8")), process.env.TUMPEL_STAGE || "dev");

const fetched = async (url, fix) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}; ${fix}`);
  return response;
};

export const downloadAsset = async (repository, version, asset, cacheDir) => {
  const url = releaseAssetUrl(repository, version, asset);
  const fix = `pin a release of ${repository} in ${PINS_PATH} that attaches ${asset} and ${asset}.sha256`;
  const digest = (await (await fetched(`${url}.sha256`, fix)).text()).split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${url}.sha256 holds no sha256; ${fix}`);
  const path = join(cacheDir, repository, `v${version}`, asset);
  if (!cached(path, digest)) await fetchVerified(url, digest, path, fix);
  return { url, path, digest, sizeBytes: statSync(path).size };
};

export const supervisorRelease = async (version) => {
  const url = releaseAssetUrl(SUPERVISOR_REPOSITORY, version, "release.json");
  const fix = `pin a release of ${SUPERVISOR_REPOSITORY} in ${PINS_PATH} that attaches release.json`;
  const release = SupervisorReleaseSchema.parse(await (await fetched(url, fix)).json());
  if (release.supervisorVersion !== version)
    throw new Error(`${url} names supervisor ${release.supervisorVersion}, not ${version}; ${fix}`);
  return release;
};

const overlaps = (oldest, version, window) => oldest <= window.Version && version >= window.Oldest;

export const supervisorRefusal = (release, channel, guest, imageGuestProtocolVersion) => {
  const pinned = `supervisor ${release.supervisorVersion}`;
  const fix = `pin a supervisor release in ${PINS_PATH} whose window meets it`;
  if (!overlaps(release.channelProtocolOldest, release.channelProtocolVersion, channel))
    return `${pinned} speaks channel protocol ${release.channelProtocolOldest} to ${release.channelProtocolVersion}, and this commit accepts ${channel.Oldest} to ${channel.Version}; ${fix}`;
  if (!overlaps(release.guestProtocolOldest, release.guestProtocolVersion, guest))
    return `${pinned} speaks guest protocol ${release.guestProtocolOldest} to ${release.guestProtocolVersion}, and this commit speaks ${guest.Oldest} to ${guest.Version}; ${fix}`;
  if (
    imageGuestProtocolVersion < release.guestProtocolOldest ||
    imageGuestProtocolVersion > release.guestProtocolVersion
  )
    return `${pinned} speaks guest protocol ${release.guestProtocolOldest} to ${release.guestProtocolVersion}, and the guests of the image release speak ${imageGuestProtocolVersion}; ${fix}, or push a tag images-vX.Y.Z to publish matching images`;
  return undefined;
};

export const cliSource = async (version, cacheDir) => {
  const path = join(cacheDir, CLI_REPOSITORY, `v${version}`, "src", "main.rs");
  if (existsSync(path)) return path;
  const url = `https://raw.githubusercontent.com/${CLI_REPOSITORY}/v${version}/src/main.rs`;
  const source = await (await fetched(url, `pin a release of ${CLI_REPOSITORY} in ${PINS_PATH} that exists`)).text();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
};
