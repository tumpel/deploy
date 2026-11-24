import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { rolloutClock } = await import(pathToFileURL(join(process.cwd(), "npm-scripts", "rollout.mjs")));
let now = Number(process.env.RELEASE_SCENARIO_TIME);
rolloutClock.now = () => now;
rolloutClock.sleep = async (milliseconds) => {
  appendFileSync(process.env.RELEASE_SCENARIO_SLEEPS, `${milliseconds}\n`);
  now += milliseconds;
};
