#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const API = "https://api.cloudflare.com/client/v4";
const STAGE = process.env.TUMPEL_STAGE ?? "dev";
const BUILDER_BUCKET = "tumpel-builder-secrets";
const HANDOFF_OBJECT = `infra-outputs-${STAGE}.json`;
const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

const die = (message) => {
  console.error(`deploy: ${message}`);
  process.exit(1);
};

const [checkout, databaseId] = process.argv.slice(2);
if (!checkout || !databaseId) die("usage: npm run deploy:code -- <tumpel/control-plane checkout> <D1 database id>");
const token = process.env.CLOUDFLARE_API_TOKEN || die("CLOUDFLARE_API_TOKEN is not set");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || die("CLOUDFLARE_ACCOUNT_ID is not set");
const ROOT = resolve(checkout);
const PACKAGE = join(ROOT, "packages", "control-plane");
const DASHBOARD = join(ROOT, "packages", "dashboard-site");

const run = (command, args, { cwd = ROOT, capture = false } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    timeout: 600_000,
  });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result.stdout;
};
const wrangler = (args, cwd = PACKAGE) =>
  run(join(ROOT, "node_modules", ".bin", "wrangler"), [...args, "--env", STAGE], { cwd });

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
if (handoff.d1_database_id !== databaseId)
  die(`the infra of ${STAGE} names D1 database ${handoff.d1_database_id}, not ${databaseId}`);
const config = join(PACKAGE, "wrangler.jsonc");
writeFileSync(config, readFileSync(config, "utf8").replaceAll(PLACEHOLDER_DATABASE_ID, databaseId));

wrangler(["deploy", "--var", `API_ORIGIN:https://${handoff.hostname}`], DASHBOARD);
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
  `DEPLOYED_COMMIT:${run("git", ["rev-parse", "HEAD"], { capture: true }).trim()}`,
]);
console.log(`deploy: https://${handoff.hostname} and https://${handoff.dashboard_hostname}`);
