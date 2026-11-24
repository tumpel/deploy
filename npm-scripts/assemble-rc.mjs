import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateFor, checkedCandidate, readCandidate } from "./rollout.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RELEASE = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;
const SHA = /^[0-9a-f]{40}$/;

const die = (message) => {
  console.error(`${basename(process.argv[1])}: ${message}`);
  process.exit(1);
};

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

const githubApi = async (path) => JSON.parse(run("gh", ["api", path.slice(1)]));

const identifiers = (version) => {
  const [core, pre] = version.split("-", 2);
  return { core: core.split(".").map(Number), pre: pre === undefined ? [] : pre.split(".") };
};

const compareIdentifier = (a, b) => {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

const compareVersions = (a, b) => {
  const left = identifiers(a);
  const right = identifiers(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const order = compareIdentifier(left.pre[i], right.pre[i]);
    if (order !== 0) return order;
  }
  return left.pre.length - right.pre.length;
};

const latestRelease = async (repository, pinned, github) => {
  const versions = (await github(`/repos/${repository}/releases?per_page=100`))
    .filter((release) => !release.draft)
    .map((release) => release.tag_name.replace(/^v/, ""))
    .filter((version) => RELEASE.test(version))
    .sort(compareVersions);
  const latest = versions.at(-1);
  if (latest === undefined) die(`${repository} has no published X.Y.Z or X.Y.Z-rc.N release`);
  if (compareVersions(latest, pinned) < 0)
    die(`the latest release of ${repository} is ${latest}, older than the pinned ${pinned}`);
  return latest;
};

const latestCheckedCommit = async (repository, pinned, github) => {
  if (!SHA.test(pinned)) die("The pinned commit is invalid; pin a full commit SHA.");
  const { workflow_runs: runs } = await github(
    `/repos/${repository}/actions/runs?branch=main&event=push&status=success&per_page=50`,
  );
  const sha = runs.find((run) => run.name === "checks")?.head_sha;
  if (sha === undefined) die(`${repository} has no main commit whose checks passed`);
  const { status } = await github(`/repos/${repository}/compare/${pinned}...${sha}`);
  if (status !== "ahead" && status !== "identical")
    die("The candidate regresses a commit pin; merge the component history first.");
  return sha;
};

const nextTag = (git) => {
  const tags = git(["tag", "--list", "v*"])
    .split("\n")
    .filter((tag) => RELEASE_TAG.test(tag))
    .sort((a, b) => compareVersions(a.slice(1), b.slice(1)));
  const last = tags.at(-1);
  if (last === undefined) die("the repository holds no vX.Y.Z or vX.Y.Z-rc.N tag to continue from");
  const [, major, minor, patch, candidate] = RELEASE_TAG.exec(last);
  if (candidate !== undefined) return { last, next: `v${major}.${minor}.${patch}-rc.${Number(candidate) + 1}` };
  return { last, next: `v${major}.${minor}.${Number(patch) + 1}-rc.1` };
};

export const advancePublishedCandidate = async (candidate, advance) => {
  if (candidate === undefined) return;
  checkedCandidate(candidate);
  await advance();
};

export const assembleRc = async ({ root, github, command, dryRun, stage }) => {
  const git = (args) => command("git", args);
  const pinsPath = join(root, "release-pins.json");
  const pins = JSON.parse(readFileSync(pinsPath, "utf8"));
  const SOURCES = {
    supervisor: (pinned) => latestRelease("tumpel/supervisor", pinned, github),
    cli: (pinned) => latestRelease("tumpel/cli", pinned, github),
    controlPlane: (pinned) => latestCheckedCommit("tumpel/control-plane", pinned, github),
    infra: (pinned) => latestCheckedCommit("tumpel/infra", pinned, github),
  };
  const unknown = Object.keys(pins).filter((name) => !(name in SOURCES));
  if (unknown.length > 0)
    die(`release-pins.json names ${unknown.join(", ")}, which this script has no release source for`);

  const assembled = Object.fromEntries(
    await Promise.all(Object.entries(pins).map(async ([name, pinned]) => [name, await SOURCES[name](pinned)])),
  );
  const changed = Object.keys(pins).filter((name) => assembled[name] !== pins[name]);
  for (const name of Object.keys(pins))
    console.log(
      changed.includes(name) ? `- ${name}: ${pins[name]}\n+ ${name}: ${assembled[name]}` : `  ${name}: ${pins[name]}`,
    );

  const { last, next } = nextTag(git);
  const headTagged = git(["tag", "--points-at", "HEAD"])
    .split("\n")
    .some((tag) => RELEASE_TAG.test(tag));
  const tag = changed.length === 0 && headTagged ? "" : next;
  console.log(
    tag === "" ? `no new RC: the pins are current and HEAD carries a release tag` : `RC ${tag} follows ${last}`,
  );

  if (dryRun || tag === "") return;
  git(["checkout", "--detach"]);
  if (changed.length > 0) {
    writeFileSync(pinsPath, `${JSON.stringify(assembled, null, 2)}\n`);
    git(["config", "user.name", "github-actions[bot]"]);
    git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    git(["add", "release-pins.json"]);
    git(["commit", "-m", `chore(release): pin the latest releases for ${tag}`]);
  }
  console.log(
    "::notice::Candidate client evidence is absent; advancing pins before starting the existing release workflow.",
  );
  git(["push", "origin", "HEAD:refs/heads/main"]);
  git(["tag", tag]);
  git(["push", "origin", `refs/tags/${tag}`]);
  command("gh", ["workflow", "run", "release.yml", "--ref", tag, "-f", `stage=${stage}`]);
  return tag;
};

const main = async () => {
  const stage = process.env.TUMPEL_STAGE ?? "dev";
  if (process.argv.includes("--published")) {
    const pins = JSON.parse(readFileSync(join(ROOT, "release-pins.json"), "utf8"));
    const candidate = readCandidate(join(ROOT, "release-candidate.json"));
    await advancePublishedCandidate(candidateFor(candidate, pins, stage), async () =>
      run("git", ["push", "origin", "HEAD:refs/heads/main"]),
    );
    return;
  }
  const dryRun = process.argv.includes("--dry-run");
  const tag = await assembleRc({ root: ROOT, github: githubApi, command: run, dryRun, stage });
  if (tag && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=\n`);
};
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
