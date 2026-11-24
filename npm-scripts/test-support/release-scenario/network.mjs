import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const route = (target) => new URL(`/?${new URLSearchParams({ target })}`, process.env.RELEASE_SCENARIO_URL);
const fetchFromScenario = globalThis.fetch;
globalThis.fetch = (url, options) => fetchFromScenario(route(url), options);

https.request = (input, options, callback) => {
  const settings = typeof input === "string" || input instanceof URL ? options : input;
  const target =
    typeof input === "string" || input instanceof URL ? input : `https://${input.hostname ?? input.host}${input.path}`;
  return http.request(
    route(target),
    { method: settings?.method, headers: settings?.headers },
    typeof options === "function" ? options : callback,
  );
};
syncBuiltinESMExports();
