#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fetched, github } from "./candidate-source.mjs";
import { activateCandidate, candidateFor, readCandidate } from "./rollout.mjs";

const API = "https://api.cloudflare.com/client/v4";
const STAGE = process.env.TUMPEL_STAGE ?? "dev";
const BUILDER_BUCKET = "tumpel-builder-secrets";
const HANDOFF_OBJECT = `infra-outputs-${STAGE}.json`;
const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const REPOSITORY = "https://github.com/tumpel/control-plane.git";

const die = (message) => {
  console.error(`deploy: ${message}`);
  process.exit(1);
};

const databaseId = process.argv[2] || die("usage: deploy.mjs <D1 database id>");
const token =
  process.env.CLOUDFLARE_TOFU_TOKEN ||
  die("CLOUDFLARE_TOFU_TOKEN is not set; cloudflare-builds-bootstrap sets it on the Workers Builds trigger");
const accountId =
  process.env.TUMPEL_ACCOUNT_ID ||
  die("TUMPEL_ACCOUNT_ID is not set; cloudflare-builds-bootstrap sets it on the Workers Builds trigger");
const PINS = join(dirname(dirname(fileURLToPath(import.meta.url))), "release-pins.json");
const pins = JSON.parse(readFileSync(PINS, "utf8"));
const candidate = candidateFor(readCandidate(new URL("../release-candidate.json", import.meta.url)), pins, STAGE);
const pin = pins.controlPlane;
if (!pin) die("release-pins.json names no controlPlane");
const ROOT = mkdtempSync(join(tmpdir(), "control-plane-"));
const PACKAGE = join(ROOT, "packages", "control-plane");
const DASHBOARD = join(ROOT, "packages", "dashboard-site");
const wranglerEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WRANGLER_CI_"))),
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: accountId,
};

const run = (command, args, { cwd = ROOT, capture = false, env = process.env } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    timeout: 600_000,
  });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result.stdout;
};
const wrangler = (args, cwd = PACKAGE) =>
  run(join(ROOT, "node_modules", ".bin", "wrangler"), [...args, "--env", STAGE], { cwd, env: wranglerEnv });

run("git", ["init", "--quiet"]);
run("git", ["fetch", "--quiet", "--depth", "1", REPOSITORY, pin]);
run("git", ["checkout", "--quiet", "FETCH_HEAD"]);
run("npm", ["ci", "--no-audit", "--no-fund"]);

const readHandoff = async () => {
  const path = `/accounts/${accountId}/r2/buckets/${BUILDER_BUCKET}/objects/${encodeURIComponent(HANDOFF_OBJECT)}`;
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) die(`${BUILDER_BUCKET} holds no ${HANDOFF_OBJECT}; apply the infra of ${STAGE} first`);
  if (!response.ok) die(`GET ${path} returned ${response.status}; the token needs Workers R2 Storage Read`);
  return response.json();
};

const handoff = await readHandoff();
if (candidate && handoff.infra_fingerprint !== pins.infra)
  die("the infra handoff is stale; refresh it before code writes");
if (handoff.d1_database_id !== databaseId)
  die(`the infra of ${STAGE} names D1 database ${handoff.d1_database_id}, not ${databaseId}`);
const vapidJwk = createPublicKey(handoff.vapid_public_key).export({ format: "jwk" });
const vapidPublicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(vapidJwk.x, "base64url"),
  Buffer.from(vapidJwk.y, "base64url"),
]).toString("base64url");
const config = join(PACKAGE, "wrangler.jsonc");
writeFileSync(config, readFileSync(config, "utf8").replaceAll(PLACEHOLDER_DATABASE_ID, databaseId));

const releaseObject = async (key, value) => {
  const path = `/accounts/${accountId}/r2/buckets/tumpel-releases-${STAGE}/objects/${encodeURIComponent(key)}`;
  const response = await fetch(`${API}${path}`, {
    method: value === undefined ? "GET" : "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Release evidence ${key} failed (${response.status}); collect candidate evidence before deploying.`,
    );
  return value === undefined ? response.json() : undefined;
};
const dashboard = async () => wrangler(["deploy", "--var", `API_ORIGIN:https://${handoff.hostname}`], DASHBOARD);
await activateCandidate(candidate, {
  pins,
  handoff: readHandoff,
  lease: () => releaseObject("rollout.json"),
  prepared: () => releaseObject(`prepared/${candidate.candidateId}.json`),
  github,
  readiness: async () => {
    const evidence = await releaseObject(`readiness/${candidate.candidateId}.json`);
    const response = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT host_id, supervisor_version FROM hosts WHERE state = 'Online'" }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (!response.ok || !body.success || body.result.some((result) => !result.success))
      throw new Error("Online supervisor read failed; the API remains unchanged.");
    return {
      ...evidence,
      supervisors: body.result
        .flatMap((result) => result.results)
        .map((host) => ({ hostId: host.host_id, online: true, supervisorVersion: host.supervisor_version })),
    };
  },
  manifest: async () =>
    (await fetched(`https://${handoff.hostname}/v1/releases/current?candidate=${candidate.candidateId}`)).json(),
  dashboard,
  migrate: async () => {
    wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
    const dashboardRedirects = JSON.stringify([`https://${handoff.dashboard_hostname}/auth/callback`]);
    wrangler([
      "d1",
      "execute",
      "DB",
      "--remote",
      "--yes",
      "--command",
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at, first_party) VALUES ('tumpel-dashboard', 'the tumpel dashboard', '${dashboardRedirects}', ${Date.now()}, 1) ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris, first_party = 1`,
    ]);
  },
  api: async () =>
    wrangler([
      "deploy",
      "--var",
      `ACCESS_ISSUER:${handoff.access_issuer}`,
      "--var",
      `ACCESS_AUD:${handoff.access_aud}`,
      "--var",
      `ACCESS_PROOF_COMMON_NAME:${handoff.proof_common_name}`,
      "--var",
      `ISSUER_HOSTNAME:${handoff.issuer_hostname}`,
      "--var",
      `DASHBOARD_ORIGIN:https://${handoff.dashboard_hostname}`,
      "--var",
      `API_ORIGIN:https://${handoff.hostname}`,
      "--var",
      `VAPID_PUBLIC_KEY:${vapidPublicKey}`,
      "--var",
      `VAPID_SUBJECT:https://${handoff.hostname}`,
      "--var",
      `DEPLOYED_COMMIT:${pin}`,
    ]),
  active: async () => {
    const response = await fetch(
      `${API}/accounts/${accountId}/workers/scripts/tumpel-control-plane-${STAGE}/settings`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = await response.json();
    if (!response.ok || !body.success)
      throw new Error("Worker activation read-back failed; the stage remains claimed.");
    return body.result.bindings.find((binding) => binding.name === "DEPLOYED_COMMIT" && binding.type === "plain_text")
      ?.text;
  },
  receipt: (value) => releaseObject(`activated/${candidate.candidateId}.json`, value),
});
console.log(`deploy: https://${handoff.hostname} and https://${handoff.dashboard_hostname}`);
