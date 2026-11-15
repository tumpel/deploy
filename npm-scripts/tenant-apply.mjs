#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { githubToken, loadCredential, tenantSecretEnv } from "./credentials.mjs";

const TUMPEL = process.env.TUMPEL_BIN ?? "tumpel";
const USAGE = "usage: npm run tenant:apply -- <tenant config path> [--endpoint <url>]";

const die = (message) => {
  console.error(`tenant:apply: ${message}`);
  process.exit(1);
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { endpoint: { type: "string" } },
});
if (positionals.length !== 1) die(USAGE);
const [file] = positionals;
if (!existsSync(file)) die(`${file} does not exist; ${USAGE}`);

const config = (() => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return die(`${file} is not valid JSON; run tumpel config validate ${file}`);
  }
})();
if (!Array.isArray(config.secretSets)) die(`${file} holds no secretSets; run tumpel config validate ${file}`);

const secrets = tenantSecretEnv(
  config,
  { credential: () => loadCredential("TUMPEL_CREDENTIAL", die), github: () => githubToken(die) },
  die,
);
const endpoint = values.endpoint ? { TUMPEL_ENDPOINT: values.endpoint } : {};
const rewrite = config.secretSets.flatMap((set) => ["--rewrite-secrets", set.name]);

const child = spawnSync(TUMPEL, ["config", "apply", file, ...rewrite], {
  stdio: "inherit",
  env: { ...process.env, ...endpoint, ...secrets },
});
if (child.error) die(`${TUMPEL} config apply: ${child.error.message}; set TUMPEL_BIN or put tumpel on PATH`);
process.exit(child.status ?? 1);
