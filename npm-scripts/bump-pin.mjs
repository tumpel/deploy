import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DEPLOY = "/repos/tumpel/deploy";
const CANDIDATE = /^rc\.([1-9]\d*)$/;
const COMMIT = /^[a-f0-9]{40}$/;

export const bumpPin = async ({ packageName, tag, commit, token }, github = fetch) => {
  const candidate = CANDIDATE.exec(tag);
  if (!["control-plane", "dashboard"].includes(packageName) || !candidate)
    throw new Error("Run bump-pin.mjs <control-plane|dashboard> rc.<N>");
  if (!COMMIT.test(commit)) throw new Error("Set GITHUB_SHA to the commit whose checks passed");
  if (!token?.trim()) throw new Error("Set GH_TOKEN to the release app installation token");

  const file = `pins/${packageName}.json`;
  const contents = `${DEPLOY}/contents/${file}`;
  const pinPath = `${contents}?ref=main`;
  const source = `/repos/tumpel/${packageName}`;
  const subject = new RegExp(`^chore\\(pins\\): deploy ${packageName} rc\\.([1-9]\\d*) to dev$`);
  const request = (path, options) =>
    github(`https://api.github.com${path}`, {
      ...options,
      headers: {
        accept: "application/vnd.github+json",
        ...(path.startsWith(`${DEPLOY}/`) && { authorization: `Bearer ${token}` }),
        ...(options?.body && { "content-type": "application/json" }),
      },
      signal: AbortSignal.timeout(30_000),
    });
  const get = async (path) => {
    const response = await request(path);
    if (response.status === 404 && path === pinPath) throw new Error(`${file} does not exist on tumpel/deploy`);
    if (!response.ok) throw new Error(`GitHub GET ${path} failed (${response.status})`);
    return response.json();
  };

  const release = await get(`${source}/releases/tags/${tag}`);
  if (release.draft || !release.published_at || release.tag_name !== tag)
    throw new Error(`${packageName} ${tag} must be published before bumping the pin`);
  const tagged = await get(`${source}/commits/refs%2Ftags%2F${tag}`);
  if (tagged.sha !== commit) throw new Error(`${packageName} ${tag} must tag the checked commit ${commit}`);
  const assets = new Set(release.assets.filter((asset) => asset.state === "uploaded").map((asset) => asset.name));
  const artifact =
    packageName === "control-plane"
      ? `control-plane-${tag}.tgz`
      : [...assets].find((name) => /^dashboard-.+\.tgz$/.test(name));
  if (!assets.has(artifact) || !assets.has(`${artifact}.sha256`))
    throw new Error(`${packageName} ${tag} needs its artifact and matching .sha256 asset`);

  const candidateNumber = BigInt(candidate[1]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { sha, content } = await get(pinPath);
    const { release: pinnedRelease } = JSON.parse(Buffer.from(content, "base64").toString("utf8"));
    if (!COMMIT.test(sha) || typeof pinnedRelease !== "string")
      throw new Error(`${file} needs a release and a valid GitHub blob SHA`);
    const history = await get(`${DEPLOY}/commits?sha=main&path=${file}&per_page=100`);
    let highWater = 0n;
    for (const entry of history) {
      const match = subject.exec(entry.commit.message.split("\n", 1)[0]);
      if (!match) continue;
      const recorded = BigInt(match[1]);
      if (recorded > highWater) highWater = recorded;
    }
    if (pinnedRelease === tag || highWater >= candidateNumber) {
      console.log(`${file} stays on ${pinnedRelease}`);
      return;
    }

    const response = await request(contents, {
      method: "PUT",
      body: JSON.stringify({
        message: `chore(pins): deploy ${packageName} ${tag} to dev`,
        content: Buffer.from(`${JSON.stringify({ release: tag, commit }, null, 2)}\n`).toString("base64"),
        sha,
        branch: "main",
      }),
    });
    if (response.ok) return;
    if (attempt === 1 || (response.status !== 409 && response.status !== 422))
      throw new Error(`GitHub could not update ${file} (${response.status})`);
    await sleep(1000 * 2 ** attempt);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [packageName, tag] = process.argv.slice(2);
  await bumpPin({ packageName, tag, commit: process.env.GITHUB_SHA, token: process.env.GH_TOKEN });
}
