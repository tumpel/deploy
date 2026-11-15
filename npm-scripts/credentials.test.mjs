import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCredential, tenantSecretEnv } from "./credentials.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(ROOT, ".tmp"), { recursive: true });
const DIR = mkdtempSync(join(ROOT, ".tmp", "credentials-test-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

const die = (message) => {
  throw new Error(message);
};

const credentialsFile = (oauth) => {
  const path = join(DIR, `credentials-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth }));
  return path;
};

test("the host credential yields the subscription token and its expiry as an offset date-time", () => {
  const path = credentialsFile({ accessToken: "sk-ant-oat01-EXAMPLE", expiresAt: Date.UTC(2026, 10, 15, 12) });
  const credential = loadCredential("TEST_CREDENTIAL", die, { TEST_CREDENTIAL: `claude-credentials:${path}` });
  assert.deepEqual(credential, { token: "sk-ant-oat01-EXAMPLE", expiresAt: "2026-11-15T12:00:00.000+00:00" });
});

test("a credential that is not a subscription token is refused", () => {
  const path = credentialsFile({ accessToken: "sk-ant-api03-EXAMPLE", expiresAt: Date.UTC(2026, 10, 15, 12) });
  assert.throws(
    () => loadCredential("TEST_CREDENTIAL", die, { TEST_CREDENTIAL: `claude-credentials:${path}` }),
    /is not a Claude Code subscription token/,
  );
});

test("a credential without an expiry is refused", () => {
  const path = credentialsFile({ accessToken: "sk-ant-oat01-EXAMPLE" });
  assert.throws(
    () => loadCredential("TEST_CREDENTIAL", die, { TEST_CREDENTIAL: `claude-credentials:${path}` }),
    /has no expiry/,
  );
});

test("the tumpel-dev config gets every variable it names from the credential and gh", () => {
  const config = JSON.parse(readFileSync(join(ROOT, "doc", "personas", "tumpel-dev.json"), "utf8"));
  const env = tenantSecretEnv(
    config,
    {
      credential: () => ({ token: "sk-ant-oat01-EXAMPLE", expiresAt: "2026-11-15T12:00:00.000+00:00" }),
      github: () => "github-EXAMPLE",
      env: {},
    },
    die,
  );
  assert.deepEqual(env, {
    TUMPEL_DEV_CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-EXAMPLE",
    TUMPEL_DEV_CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: "2026-11-15T12:00:00.000+00:00",
    TUMPEL_DEV_GITHUB_TOKEN: "github-EXAMPLE",
  });
});

test("a secret the loader cannot fill must already be exported", () => {
  const config = {
    secretSets: [
      {
        name: "prod",
        secrets: [{ kind: "ApiKey", name: "OPENAI_API_KEY", provider: "OpenAI", valueFrom: { env: "PROD_OPENAI" } }],
      },
    ],
  };
  const sources = { credential: () => die("unused"), github: () => die("unused") };
  assert.throws(() => tenantSecretEnv(config, { ...sources, env: {} }, die), /export it first/);
  assert.deepEqual(tenantSecretEnv(config, { ...sources, env: { PROD_OPENAI: "set" } }, die), {});
});
