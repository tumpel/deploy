#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECONDS = 30;

let home = "";

const die = (message) => {
  if (home) rmSync(home, { recursive: true, force: true });
  console.error(`smoke:pi: ${message}`);
  process.exit(1);
};

const [pi] = process.argv.slice(2);
if (!pi) die("pass the Pi binary: npm run smoke:pi -- <harness layer>/bin/pi");

const scratch = join(homedir(), "development", ".tmp");
mkdirSync(scratch, { recursive: true });
home = mkdtempSync(join(scratch, "pi-smoke-"));
const environment = (extra) => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  LANG: "C.UTF-8",
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  ...extra,
});

const unknownModel = () => {
  const run = spawnSync(pi, ["--mode", "rpc", "--model", "tumpel-smoke-no-such-model"], {
    cwd: home,
    env: environment({ OPENROUTER_API_KEY: "tumpel-smoke-stub" }),
    input: "",
    encoding: "utf8",
    timeout: SECONDS * 1000,
  });
  if (run.status !== 1 || !run.stderr.includes('Model "tumpel-smoke-no-such-model" not found'))
    die(`an unknown model should exit 1 naming the model; it exited ${run.status ?? run.signal}: ${run.stderr}`);
};

const missingKey = () =>
  new Promise((resolve) => {
    const child = spawn(pi, ["--mode", "rpc", "--model", "openrouter/tumpel/smoke"], {
      cwd: home,
      env: environment({}),
      stdio: ["pipe", "pipe", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill();
      die(`Pi answered no prompt within ${SECONDS} s`);
    }, SECONDS * 1000);
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const record = JSON.parse(line);
        if (record.type !== "response" || record.command !== "prompt") continue;
        clearTimeout(timer);
        child.stdin.end();
        if (record.success !== false || !String(record.error).startsWith("No API key found for openrouter"))
          die(`a prompt without OPENROUTER_API_KEY should be refused for the missing key; Pi answered ${line}`);
        resolve();
      }
    });
    child.stdin.write(`${JSON.stringify({ type: "prompt", message: "say hi" })}\n`);
  });

unknownModel();
await missingKey();
rmSync(home, { recursive: true, force: true });
console.log(`smoke:pi: ${pi} refuses an unknown model and a prompt without OPENROUTER_API_KEY`);
