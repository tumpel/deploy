import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { candidateSource, fetched } from "./candidate-source.mjs";
import { checkedCandidate, exactChecks, verifyManifest } from "./rollout.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PINS_PATH = join(ROOT, "release-pins.json");
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

const api = (path) => JSON.parse(run("gh", ["api", path]));

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

const latestRelease = (repository, pinned) => {
  const versions = api(`repos/${repository}/releases?per_page=100`)
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

const latestCheckedCommit = async (repository, pinned) => {
  if (!SHA.test(pinned)) die("The pinned commit is invalid; pin a full commit SHA.");
  const { sha } = api(`repos/${repository}/commits/main`);
  await exactChecks(repository, sha, async (path) => api(path.slice(1)));
  const { status } = api(`repos/${repository}/compare/${pinned}...${sha}`);
  if (status !== "ahead" && status !== "identical")
    die("The candidate regresses a commit pin; merge the component history first.");
  return sha;
};

const SOURCES = {
  supervisor: (pinned) => latestRelease("tumpel/supervisor", pinned),
  cli: (pinned) => latestRelease("tumpel/cli", pinned),
  controlPlane: (pinned) => latestCheckedCommit("tumpel/control-plane", pinned),
  infra: (pinned) => latestCheckedCommit("tumpel/infra", pinned),
};

const nextTag = () => {
  const tags = run("git", ["tag", "--list", "v*"])
    .split("\n")
    .filter((tag) => RELEASE_TAG.test(tag))
    .sort((a, b) => compareVersions(a.slice(1), b.slice(1)));
  const last = tags.at(-1);
  if (last === undefined) die("the repository holds no vX.Y.Z or vX.Y.Z-rc.N tag to continue from");
  const [, major, minor, patch, candidate] = RELEASE_TAG.exec(last);
  if (candidate !== undefined) return { last, next: `v${major}.${minor}.${patch}-rc.${Number(candidate) + 1}` };
  return { last, next: `v${major}.${minor}.${Number(patch) + 1}-rc.1` };
};

export const assembleCandidate = async (
  candidate,
  { tag, publish, observe, readBack, advance, clock = { sleep: setTimeout } },
) => {
  checkedCandidate(candidate);
  const sha = await tag();
  await publish();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { workflow_runs: runs } = await observe(sha);
    const [release] = runs
      .filter((run) => run.head_sha === sha && run.event === "workflow_dispatch")
      .sort((a, b) => b.id - a.id);
    if (release?.status === "completed") {
      if (release.conclusion !== "success")
        throw new Error("Candidate publication failed; main pins remain unchanged.");
      verifyManifest(candidate, await readBack());
      await advance();
      return;
    }
    if (attempt === 9) throw new Error("Publication timed out after 10 observations; main pins remain unchanged.");
    await clock.sleep(1000 * 2 ** attempt);
  }
};

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const pins = JSON.parse(readFileSync(PINS_PATH, "utf8"));
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

  const { last, next } = nextTag();
  const headTagged = run("git", ["tag", "--points-at", "HEAD"])
    .split("\n")
    .some((tag) => RELEASE_TAG.test(tag));
  const tag = changed.length === 0 && headTagged ? "" : next;
  console.log(
    tag === "" ? `no new RC: the pins are current and HEAD carries a release tag` : `RC ${tag} follows ${last}`,
  );

  if (dryRun || tag === "") process.exit(0);
  const stage = process.env.TUMPEL_STAGE ?? "dev";
  const github = async (path) => api(path.slice(1));
  const candidate = await candidateSource({ pins: assembled, stage, github });
  await assembleCandidate(candidate, {
    tag: async () => {
      run("git", ["checkout", "--detach"]);
      writeFileSync(PINS_PATH, `${JSON.stringify(assembled, null, 2)}\n`);
      writeFileSync(join(ROOT, "release-candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`);
      run("git", ["config", "user.name", "github-actions[bot]"]);
      run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
      run("git", ["add", "release-pins.json", "release-candidate.json"]);
      run("git", ["commit", "-m", `chore(release): freeze candidate ${tag}`]);
      run("git", ["tag", tag]);
      run("git", ["push", "origin", `refs/tags/${tag}`]);
      return run("git", ["rev-parse", "HEAD"]);
    },
    publish: async () => {
      run("gh", ["workflow", "run", "release.yml", "--ref", tag, "-f", `stage=${stage}`]);
    },
    observe: async (sha) =>
      github(`/repos/tumpel/deploy/actions/workflows/release.yml/runs?head_sha=${sha}&per_page=100`),
    readBack: async () =>
      (await fetched(`https://api.${stage === "prod" ? "" : `${stage}.`}tumpel.dev/v1/releases/current`)).json(),
    advance: async () => run("git", ["push", "origin", "HEAD:refs/heads/main"]),
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=\n`);
};
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
