#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedCommit, readHandoff, readPin } from "./pinned-source.mjs";
import { downloadAsset } from "./release-download.mjs";

const API = "https://api.cloudflare.com/client/v4";
const STAGE = process.env.TUMPEL_STAGE ?? "dev";
const WORKER = `tumpel-control-plane-${STAGE}`;
const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const WRANGLER = join(dirname(dirname(fileURLToPath(import.meta.url))), "node_modules", ".bin", "wrangler");

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
const commit = pinnedCommit("control-plane");
const { release } = readPin("control-plane");
if (!/^rc\.[1-9]\d*$/.test(String(release))) die("pins/control-plane.json needs a release rc.<N>");
const tagged = await fetch(`https://api.github.com/repos/tumpel/control-plane/commits/refs%2Ftags%2F${release}`, {
  headers: { accept: "application/vnd.github+json" },
  signal: AbortSignal.timeout(30_000),
});
if (!tagged.ok) die(`GitHub GET of control plane ${release} returned ${tagged.status}`);
const taggedCommit = (await tagged.json()).sha;
if (taggedCommit !== commit) die(`control plane ${release} tags ${taggedCommit}, not the pinned commit ${commit}`);

const wranglerEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WRANGLER_CI_"))),
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: accountId,
};
const PACKAGE = mkdtempSync(join(tmpdir(), "control-plane-"));
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: PACKAGE,
    env: wranglerEnv,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 600_000,
  });
  if (result.error) die(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited with ${result.status}`);
};
const wrangler = (args) => run(WRANGLER, [...args, "--env", STAGE]);

const { path: archive } = await downloadAsset(
  "tumpel/control-plane",
  release,
  `control-plane-${release}.tgz`,
  mkdtempSync(join(tmpdir(), "control-plane-release-")),
).catch((error) => die(error.message));
run("tar", ["-xzf", archive]);

const config = join(PACKAGE, "wrangler.jsonc");
const packaged = JSON.parse(readFileSync(config, "utf8"));
const tags = (packaged.env?.[STAGE]?.migrations ?? packaged.migrations ?? []).map((migration) => migration.tag);
const servicePath = `/accounts/${accountId}/workers/services/${WORKER}`;
const service = await fetch(`${API}${servicePath}`, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(30_000),
});
if (service.status !== 404) {
  const body = await service.json();
  if (!service.ok || !body.success) die(`GET ${servicePath} returned ${service.status}; check the tumpel-tofu token`);
  const deployed = body.result.default_environment.script.migration_tag;
  if (deployed && !tags.includes(deployed))
    die(
      `${WORKER} runs Durable Object migration ${deployed}, which control plane ${release} does not carry; this revert crosses that migration, so fix forward in tumpel/control-plane instead`,
    );
}

const handoff = await readHandoff({ stage: STAGE, accountId, token }, die);
if (handoff.d1_database_id !== databaseId)
  die(`the infra of ${STAGE} names D1 database ${handoff.d1_database_id}, not ${databaseId}`);
const vapidJwk = createPublicKey(handoff.vapid_public_key).export({ format: "jwk" });
const vapidPublicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(vapidJwk.x, "base64url"),
  Buffer.from(vapidJwk.y, "base64url"),
]).toString("base64url");
writeFileSync(config, readFileSync(config, "utf8").replaceAll(PLACEHOLDER_DATABASE_ID, databaseId));

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
  `VAPID_PUBLIC_KEY:${vapidPublicKey}`,
  "--var",
  `VAPID_SUBJECT:https://${handoff.hostname}`,
  "--var",
  `DEPLOYED_COMMIT:${commit}`,
]);
console.log(`deploy: control plane ${release} (${commit}) at https://${handoff.hostname}`);
