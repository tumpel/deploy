import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateSource } from "./candidate-source.mjs";
import { candidateFor, checkedCandidate, exactChecks, readCandidate } from "./rollout.mjs";

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

export const latestCheckedCommit = async (repository, pinned, github, candidate, clock) => {
  if (!SHA.test(pinned)) die("The pinned commit is invalid; pin a full commit SHA.");
  let sha;
  if (candidate) {
    ({ sha } = await github(`/repos/${repository}/commits/main`));
    await exactChecks(repository, sha, github, clock);
  } else {
    const { workflow_runs: runs } = await github(
      `/repos/${repository}/actions/runs?branch=main&event=push&status=success&per_page=50`,
    );
    sha = runs.find((run) => run.name === "checks")?.head_sha;
    if (sha === undefined) die(`${repository} has no main commit whose checks passed`);
  }
  const { status } = await github(`/repos/${repository}/compare/${pinned}...${sha}`);
  if (status !== "ahead" && status !== "identical")
    die("The candidate regresses a commit pin; merge the component history first.");
  return sha;
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

export const assembleCandidate = async (candidate, { tag, publish, advance, notice = console.log }) => {
  if (candidate === undefined) {
    notice(
      "::notice::Candidate client evidence is absent; advancing pins before starting the existing release workflow.",
    );
    await advance();
  } else {
    checkedCandidate(candidate);
  }
  await tag();
  await publish();
};

export const advancePublishedCandidate = async (candidate, advance) => {
  if (candidate === undefined) return;
  checkedCandidate(candidate);
  await advance();
};

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const pins = JSON.parse(readFileSync(PINS_PATH, "utf8"));
  const stage = process.env.TUMPEL_STAGE ?? "dev";
  const input = readCandidate(join(ROOT, "release-candidate.json"));
  const candidate = candidateFor(input, input?.pins ?? pins, stage);
  if (process.env.GITHUB_EVENT_NAME === "repository_dispatch" && candidate === undefined)
    die("Candidate client readiness evidence is missing. Supply it before starting automated assembly.");
  if (process.argv.includes("--published")) {
    await advancePublishedCandidate(candidateFor(input, pins, stage), async () =>
      run("git", ["push", "origin", "HEAD:refs/heads/main"]),
    );
    return;
  }
  const github = async (path) => api(path.slice(1));
  const SOURCES = {
    supervisor: (pinned) => latestRelease("tumpel/supervisor", pinned),
    cli: (pinned) => latestRelease("tumpel/cli", pinned),
    controlPlane: (pinned) => latestCheckedCommit("tumpel/control-plane", pinned, github, candidate),
    infra: (pinned) => latestCheckedCommit("tumpel/infra", pinned, github, candidate),
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

  const { last, next } = nextTag();
  const headTagged = run("git", ["tag", "--points-at", "HEAD"])
    .split("\n")
    .some((tag) => RELEASE_TAG.test(tag));
  const tag = changed.length === 0 && headTagged ? "" : next;
  console.log(
    tag === "" ? `no new RC: the pins are current and HEAD carries a release tag` : `RC ${tag} follows ${last}`,
  );

  if (dryRun || tag === "") process.exit(0);
  if (candidate) {
    candidateFor(candidate, assembled, stage);
    const source = await candidateSource({ pins: assembled, stage, github, clock: { now: () => candidate.createdAt } });
    if (source.candidateId !== candidate.candidateId)
      die("The published source differs from candidate evidence; assemble matching evidence before continuing.");
  }
  run("git", ["checkout", "--detach"]);
  if (changed.length > 0) {
    writeFileSync(PINS_PATH, `${JSON.stringify(assembled, null, 2)}\n`);
    run("git", ["config", "user.name", "github-actions[bot]"]);
    run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    run("git", ["add", "release-pins.json"]);
    run("git", ["commit", "-m", `chore(release): pin the latest releases for ${tag}`]);
  }
  await assembleCandidate(candidate, {
    tag: async () => {
      run("git", ["tag", tag]);
      run("git", ["push", "origin", `refs/tags/${tag}`]);
    },
    publish: async () => {
      run("gh", ["workflow", "run", "release.yml", "--ref", tag, "-f", `stage=${stage}`]);
    },
    advance: async () => run("git", ["push", "origin", "HEAD:refs/heads/main"]),
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=\n`);
};
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
