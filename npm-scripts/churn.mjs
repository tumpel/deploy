#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const API = "https://api.cloudflare.com/client/v4";
const DEV_ACCOUNT = "f496802dcadb597e5939f6449c759a43";
const BUCKET_MS = 10 * 60_000;
const BUCKETS_PER_QUERY = 36;

const die = (message) => {
  console.error(`churn: ${message}`);
  process.exit(2);
};

const { values } = parseArgs({
  options: {
    hours: { type: "string", default: "6" },
    since: { type: "string" },
    until: { type: "string" },
    threshold: { type: "string", default: "100" },
    script: { type: "string", default: "tumpel-control-plane-dev" },
  },
});

const positive = (name, text) => {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) die(`--${name} must be a positive number, not ${text}`);
  return value;
};
const instant = (name, text) => {
  const value = Date.parse(text);
  if (Number.isNaN(value)) die(`--${name} must be an ISO 8601 date-time, not ${text}`);
  return value;
};

const threshold = positive("threshold", values.threshold);
const until = values.until ? instant("until", values.until) : Date.now();
const since = values.since ? instant("since", values.since) : until - positive("hours", values.hours) * 3_600_000;
if (since >= until) die("--since must come before --until");
const start = Math.floor(since / BUCKET_MS) * BUCKET_MS;
const buckets = [];
for (let at = start; at < until; at += BUCKET_MS) buckets.push(at);

const dotfilesToken = async () => {
  const dotfiles = join(homedir(), "development", "dotfiles");
  const age = await import(
    pathToFileURL(join(dotfiles, "tools", "dotfiles-key", "node_modules", "age-encryption", "dist", "index.js")).href
  ).catch(() => die("set CLOUDFLARE_API_TOKEN, or install dotfiles-key to read cloudflare-user-readonly"));
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(readFileSync(join(homedir(), ".config", "dotfiles-key", "identity"), "utf8").trim());
  const text = await decrypter.decrypt(readFileSync(join(dotfiles, "secrets", "cloudflare-user-readonly.age")), "text");
  const line = text.split("\n").find((entry) => /^(export\s+)?CLOUDFLARE_USER_TOKEN=/.test(entry));
  if (!line) die("the dotfiles key cloudflare-user-readonly holds no CLOUDFLARE_USER_TOKEN");
  return line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
};

const token = process.env.CLOUDFLARE_API_TOKEN || (await dotfilesToken());
const account = process.env.TUMPEL_ACCOUNT_ID || DEV_ACCOUNT;

const cf = async (method, path, body) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = (await response.text()).replaceAll(token, "[redacted]");
  const parsed = JSON.parse(text);
  if (!response.ok || parsed.errors?.length)
    die(`${method} ${path} returned ${response.status}: ${JSON.stringify(parsed.errors).slice(0, 500)}`);
  return parsed;
};

const namespaces = Object.fromEntries(
  (await cf("GET", `/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`)).result
    .filter((namespace) => namespace.script === values.script)
    .map((namespace) => [namespace.id, namespace.class]),
);
if (Object.keys(namespaces).length === 0) die(`${values.script} has no Durable Object namespaces in ${account}`);

const iso = (ms) => new Date(ms).toISOString();
const rowsQuery = `query($account: String!, $since: Time!, $until: Time!, $namespaces: [String!]) {
  viewer { accounts(filter: {accountTag: $account}) {
    durableObjectsPeriodicGroups(limit: 10000, orderBy: [datetimeFiveMinutes_ASC],
      filter: {datetimeFiveMinutes_geq: $since, datetimeFiveMinutes_lt: $until, namespaceId_in: $namespaces}) {
      dimensions { datetimeFiveMinutes namespaceId } sum { rowsWritten rowsRead } } } } }`;
const rows = (
  await cf("POST", "/graphql", {
    query: rowsQuery,
    variables: { account, since: iso(start), until: iso(until), namespaces: Object.keys(namespaces) },
  })
).data.viewer.accounts[0].durableObjectsPeriodicGroups;

const perBucket = new Map(buckets.map((at) => [at, { written: {}, read: {}, worker: undefined }]));
for (const group of rows) {
  const at = Math.floor(Date.parse(group.dimensions.datetimeFiveMinutes) / BUCKET_MS) * BUCKET_MS;
  const bucket = perBucket.get(at);
  if (!bucket) continue;
  const name = namespaces[group.dimensions.namespaceId];
  bucket.written[name] = (bucket.written[name] ?? 0) + group.sum.rowsWritten;
  bucket.read[name] = (bucket.read[name] ?? 0) + group.sum.rowsRead;
}

for (let offset = 0; offset < buckets.length; offset += BUCKETS_PER_QUERY) {
  const chunk = buckets.slice(offset, offset + BUCKETS_PER_QUERY);
  const fields = chunk
    .map(
      (at, index) => `b${index}: workersInvocationsAdaptive(limit: 1,
        filter: {datetime_geq: "${iso(at)}", datetime_lt: "${iso(at + BUCKET_MS)}", scriptName: $script}) {
        sum { requests } quantiles { cpuTimeP50 cpuTimeP99 } }`,
    )
    .join("\n");
  const query = `query($account: String!, $script: String!) {
    viewer { accounts(filter: {accountTag: $account}) { ${fields} } } }`;
  const result = (await cf("POST", "/graphql", { query, variables: { account, script: values.script } })).data.viewer
    .accounts[0];
  chunk.forEach((at, index) => {
    perBucket.get(at).worker = result[`b${index}`][0];
  });
}

const total = (counts) => Object.values(counts).reduce((sum, count) => sum + count, 0);
const breakdown = (counts) =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
const ms = (microseconds) => (microseconds === undefined ? "-" : `${(microseconds / 1000).toFixed(1)}ms`);

console.log(
  `churn: ${values.script} in ${account}, ${iso(start)} to ${iso(until)}, at most ${threshold} rows written per 10 minutes`,
);
let over = 0;
for (const [at, bucket] of perBucket) {
  const written = total(bucket.written);
  const flag = written > threshold ? " OVER" : "";
  if (flag) over += 1;
  const worker = bucket.worker;
  console.log(
    [
      `${iso(at).slice(0, 16)}Z${flag}`,
      `written ${written}${written ? ` (${breakdown(bucket.written)})` : ""}`,
      `read ${total(bucket.read)}${total(bucket.read) ? ` (${breakdown(bucket.read)})` : ""}`,
      `requests ${worker?.sum.requests ?? 0}`,
      `cpu p50 ${ms(worker?.quantiles.cpuTimeP50)} p99 ${ms(worker?.quantiles.cpuTimeP99)}`,
    ].join("  "),
  );
}
if (over > 0) {
  console.error(`churn: ${over} of ${perBucket.size} buckets wrote more than ${threshold} rows`);
  process.exit(1);
}
console.log(`churn: every bucket wrote at most ${threshold} rows`);
