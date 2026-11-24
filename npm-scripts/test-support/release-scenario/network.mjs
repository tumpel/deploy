import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const route = (target) => new URL(`/?${new URLSearchParams({ target })}`, process.env.SCENARIO_URL);
const fetchRemote = globalThis.fetch;
globalThis.fetch = (url, options) => fetchRemote(route(url), options);
https.request = (input, options, callback) => {
  const url = input instanceof URL || typeof input === "string" ? input : `https://${input.hostname}${input.path}`;
  const { method, headers } = typeof input === "object" && !(input instanceof URL) ? input : options;
  return http.request(route(url), { method, headers }, typeof options === "function" ? options : callback);
};
syncBuiltinESMExports();
if (/\/(assemble-rc|deploy|release-publish)\.mjs$/.test(process.argv[1])) {
  const { rolloutClock } = await import(new URL("rollout.mjs", pathToFileURL(process.argv[1])));
  let now = 1_800_000_000_000;
  rolloutClock.now = () => now;
  rolloutClock.sleep = async (delay) => {
    appendFileSync(process.env.SCENARIO_SLEEPS, `${delay}\n`);
    now += delay;
  };
}
