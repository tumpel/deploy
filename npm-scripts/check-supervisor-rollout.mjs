import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { supervisorRolloutAllowed } from "./rollout.mjs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const base = JSON.parse(
  execFileSync("git", ["show", "HEAD^1:release-pins.json"], { encoding: "utf8", timeout: 30_000 }),
);
const proposed = read("release-pins.json");
const allowed = await supervisorRolloutAllowed(base.supervisor, proposed.supervisor, {
  eventName: process.env.GITHUB_EVENT_NAME,
  repository: process.env.GITHUB_REPOSITORY,
  event: read(process.env.GITHUB_EVENT_PATH),
});
if (!allowed) {
  console.error(
    "Supervisor rollouts are on hold until the bootstrap release. Ask a repository admin to apply supervisor-rollout-approved after the latest push.",
  );
  process.exitCode = 1;
}
