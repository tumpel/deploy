#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLONE_SECONDS } from "./guest-image-settings.mjs";
import { INLINE_CAP, loadCredential, proofTenantApply, proofTenantPlan } from "./proof-tenant.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STAGE = process.env.TUMPEL_STAGE ?? "dev";
const HOST = process.env.TUMPEL_PROOF_HOST ?? "tumpel-host";
const ENDPOINT = process.env.TUMPEL_PROOF_ENDPOINT;
const ISSUER = process.env.TUMPEL_PROOF_ISSUER;
const TENANT = process.env.TUMPEL_PROOF_TENANT ?? "Tumpel proof";
const REPOSITORY = process.env.TUMPEL_PROOF_REPOSITORY ?? "https://github.com/mvhenten/drawio-headless.git";
const MODEL = process.env.TUMPEL_PROOF_MODEL ?? "claude-haiku-4-5";
const PROBE_MODEL = process.env.TUMPEL_PROOF_PROBE_MODEL ?? "claude-sonnet-4-5";
const PREBUILD_REPOSITORY = process.env.TUMPEL_PROOF_PREBUILD_REPO;
const CALLER_WORKFLOW = ".github/workflows/tumpel-prebuild.yml";
const CLI = process.env.TUMPEL_PROOF_CLI;
const SUPERVISOR = process.env.TUMPEL_PROOF_SUPERVISOR;
const STATE_DIR = ".local/state/tumpel-supervisor";
const REVOKE_DIR = "development/.tmp/tumpel-proof-revoke";
const MARKER = `tumpel-proof-${randomBytes(4).toString("hex")}`;
const MARKER_FILE = "/root/proof-marker.txt";
const TMPFS_MARKER_FILE = "/dev/shm/proof-marker.txt";
const BUILD_PROVIDERS = ["GitHubActions", "CircleCI", "Namespace"];

const die = (message) => {
  console.error(`proof:e2e: ${message}`);
  process.exit(1);
};

if (!ENDPOINT) die("TUMPEL_PROOF_ENDPOINT is unset; run this through npm run proof:e2e, which sets it from the stage");
if (!ISSUER) die("TUMPEL_PROOF_ISSUER is unset; run this through npm run proof:e2e, which sets it from the stage");
if (!CLI) die("TUMPEL_PROOF_CLI is unset; run this through npm run proof:e2e, which downloads the release CLI");
if (!SUPERVISOR)
  die("TUMPEL_PROOF_SUPERVISOR is unset; run this through npm run proof:e2e, which downloads the release supervisor");
if (!existsSync(CLI)) die(`${CLI} is missing; set TUMPEL_PROOF_CLI to a built tumpel binary`);
if (!existsSync(SUPERVISOR)) die(`${SUPERVISOR} is missing; set TUMPEL_PROOF_SUPERVISOR to a built supervisor`);

const config = JSON.parse(
  readFileSync(join(ROOT, "packages", "control-plane", "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
);
const settings = (config.env?.[STAGE]?.vars ?? config.vars).TUMPEL_SETTINGS;

class Failed extends Error {}
const fail = (message) => {
  throw new Failed(message);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const collect = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let firstAt = null;
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      firstAt ??= Date.now();
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", (code) => resolve({ code, firstAt, out, err }));
  });

const tumpel = (args, env = {}) => {
  const result = spawnSync(CLI, args, { encoding: "utf8", env: { ...process.env, ...env }, timeout: 600_000 });
  if (result.status !== 0) fail(`tumpel ${args.slice(0, 2).join(" ")}: ${result.stderr.trim().split("\n").at(-1)}`);
  return result.stdout;
};
const tumpelJson = (args) => JSON.parse(tumpel(args));

const ssh = (command, input) => {
  const result = spawnSync("ssh", [HOST, command], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 600_000,
  });
  if (result.status !== 0) fail(`ssh ${HOST} ${command.split(" ")[0]}: ${result.stderr.trim().split("\n").at(-1)}`);
  return result.stdout;
};

const waitFor = async (what, limitMs, probe) => {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const value = probe();
    if (value) return value;
    await pause(2000);
  }
  return fail(`${what} did not happen within ${limitMs / 1000} s`);
};

const follow = async (turnId) => {
  const read = await collect(CLI, ["transcript", "read", turnId, "--follow"]);
  return { ...read, lines: read.out.split("\n").filter(Boolean) };
};

const runTurn = async ({ sessionId, personaId, prompt, model = MODEL }) => {
  const t0 = Date.now();
  const started = await collect(
    CLI,
    sessionId
      ? ["turn", "send", sessionId, "--prompt", prompt]
      : [
          "session",
          "start",
          "--repository",
          REPOSITORY,
          "--model",
          model,
          "--persona-id",
          personaId,
          "--prompt",
          prompt,
        ],
  );
  const idsMs = Date.now() - t0;
  if (started.code !== 0) fail(`starting the turn: ${started.err.trim().split("\n").at(-1)}`);
  const body = JSON.parse(started.out);
  const turnId = body.turn?.turnId ?? body.turnId;
  const session = body.session?.sessionId ?? body.sessionId ?? sessionId;
  const read = await follow(turnId);
  const turn = tumpelJson(["turn", "get", turnId]);
  const parsed = read.lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      return fail(`turn ${turnId} wrote transcript line ${index + 1}, which is not JSON`);
    }
  });
  const result = parsed.find((line) => line.type === "result");
  return {
    sessionId: session,
    turnId,
    turn,
    idsMs,
    firstLineMs: read.firstAt === null ? null : read.firstAt - t0,
    lines: read.lines,
    result,
    harnessSession: result?.session_id ?? parsed.find((line) => line.session_id)?.session_id,
    followError: read.err.trim(),
  };
};

const toolResults = (lines) =>
  lines
    .flatMap((line) => {
      try {
        const message = JSON.parse(line);
        return (message.message?.content ?? [])
          .filter((part) => part.type === "tool_result")
          .map((part) => (typeof part.content === "string" ? part.content : JSON.stringify(part.content)));
      } catch {
        return [];
      }
    })
    .join("\n");

const completed = (run, what) => {
  if (run.turn.state === "Completed") return;
  const failure = run.turn.state === "Failed" ? tumpelJson(["turn", "failure", run.turnId]) : null;
  fail(`${what} reads ${run.turn.state}${failure ? ` (${failure.reason}: ${failure.detail.slice(0, 300)})` : ""}`);
};

const hostRuntime = () => JSON.parse(ssh(`cat ${STATE_DIR}/runtime.json`));
const hostOnline = (hostId) =>
  tumpelJson(["host", "list"]).find((host) => host.hostId === hostId && host.state === "Online");

const mintToken = () => {
  const minted = spawnSync(CLI, ["host", "mint-token", "--expires-in", "600"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (minted.status !== 0) fail(`tumpel host mint-token: ${minted.stderr.trim().split("\n").at(-1)}`);
  return minted.stdout.trim();
};

const enrol = (name, envPrefix) => {
  const out = ssh(
    `${envPrefix} ./tumpel-supervisor enrol --endpoint ${ENDPOINT} --token-file - --name ${name}`,
    `${mintToken()}\n`,
  );
  return JSON.parse(out.slice(0, out.lastIndexOf("}") + 1)).hostId;
};

const MCP_URL = `${ENDPOINT}/mcp`;
const rpc = (accessToken, id, method, params = {}, protocolVersion = null) =>
  fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken === "" ? {} : { authorization: `Bearer ${accessToken}` }),
      ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

const connectorClient = (accessToken) => {
  let nextId = 1;
  let protocolVersion = null;
  const result = async (method, params) => {
    const answered = await rpc(accessToken, nextId++, method, params, protocolVersion);
    if (answered.status !== 200) fail(`${method} over /mcp answered ${answered.status}`);
    const body = await answered.json();
    if (body.error) fail(`${method} over /mcp failed: ${body.error.message}`);
    return body.result;
  };
  return {
    initialize: async () => {
      const initialized = await result("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tumpel-proof", version: "0" },
      });
      protocolVersion = initialized.protocolVersion;
      return initialized;
    },
    list: async () => (await result("tools/list", {})).tools.map((tool) => tool.name),
    call: async (name, args) => {
      const called = await result("tools/call", { name, arguments: args });
      if (called.isError) fail(`${name} over /mcp failed: ${called.content?.[0]?.text}`);
      const text = called.content?.[0]?.text ?? "";
      return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
    },
  };
};

const TOOL_CALL_LINE = /^\[[^\]\s]+\]/;

const pollConnectorTurn = async (client, sessionId, turnId, t0) => {
  const firstLineLimit =
    (settings.turnImageFetchBudgetSeconds +
      settings.turnClaimBudgetSeconds +
      CLONE_SECONDS +
      settings.turnFirstLineBudgetSeconds) *
    1000;
  const turnLimit = settings.turnTotalBudgetSeconds * 1000;
  const lines = [];
  let cursor = null;
  let firstLineMs = null;
  let polls = 0;
  while (true) {
    const page = await client.call("tumpel_transcript_read", {
      sessionId,
      turnId,
      compact: true,
      ...(cursor === null ? {} : { after: cursor }),
    });
    polls += 1;
    cursor = page.cursor;
    const texts = page.turns.flatMap((turn) => turn.lines.map((line) => line.text));
    if (texts.length > 0) {
      firstLineMs ??= Date.now() - t0;
      lines.push(...texts);
    }
    if (page.finished) break;
    const elapsed = Date.now() - t0;
    if (firstLineMs === null && elapsed > firstLineLimit) {
      fail(`turn ${turnId} wrote no compact line within ${firstLineLimit / 1000} s over /mcp`);
    }
    if (elapsed > turnLimit) fail(`turn ${turnId} did not finish within ${turnLimit / 1000} s over /mcp`);
    await pause(2000);
  }
  const turn = await client.call("tumpel_turn_get", { turnId });
  if (turn.state !== "Completed") {
    const failure = turn.state === "Failed" ? await client.call("tumpel_turn_failure", { turnId }) : null;
    fail(
      `turn ${turnId} reads ${turn.state} over /mcp${failure ? ` (${failure.reason}: ${failure.detail.slice(0, 300)})` : ""}`,
    );
  }
  return {
    turn,
    lines,
    texts: lines.filter((text) => !TOOL_CALL_LINE.test(text)),
    firstLineMs,
    turnMs: Date.now() - t0,
    polls,
  };
};

const state = {};

const issuerDocument = async (path) => {
  const response = await fetch(`${ISSUER}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (response.status !== 200) fail(`GET ${ISSUER}${path} answered ${response.status}`);
  return response.json();
};

const credential = loadCredential(die);

const probeCommand = (capacity) => {
  const boxes = Array.from({ length: capacity }, (_, k) => [`172.16.${k}.1:22`, `172.16.${k}.2:22`]).flat();
  const targets = [
    "192.168.122.188:22",
    "192.168.122.1:53",
    ...boxes,
    "10.0.0.1:22",
    "100.64.0.1:22",
    "169.254.169.254:80",
    "192.168.1.1:80",
  ];
  return [
    "own=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1);",
    'echo "PROBE self $own";',
    "timeout 4 bash -c '</dev/tcp/1.1.1.1/443' 2>/dev/null; echo \"PROBE public 1.1.1.1:443 rc=$?\";",
    "code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://example.com 2>/dev/null); echo \"PROBE public https://example.com http=$code\";",
    `for t in ${targets.join(" ")}; do [ "\${t%:*}" = "$own" ] && continue; timeout 3 bash -c "</dev/tcp/\${t%:*}/\${t#*:}" 2>/dev/null; echo "PROBE private $t rc=$?"; done`,
  ].join(" ");
};

const steps = [
  {
    id: 1,
    name: "Sign in",
    gate: true,
    run: async () => {
      const login = spawnSync(CLI, ["login", "--endpoint", ENDPOINT, "--name", `proof-${STAGE}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });
      if (login.status !== 0) fail(`tumpel login: ${login.stderr.trim().split("\n").at(-1)}`);
      const t0 = Date.now();
      const who = tumpelJson(["whoami"]);
      if (who.tenant.name !== TENANT) fail(`whoami names tenant ${who.tenant.name}, not ${TENANT}`);
      state.tenantId = who.tenant.tenantId;
      return `tenant ${who.tenant.name}, whoami ${Date.now() - t0} ms`;
    },
  },
  {
    id: 2,
    name: "Enrol",
    gate: true,
    run: async () => {
      const copied = spawnSync("scp", ["-q", SUPERVISOR, `${HOST}:tumpel-supervisor`], { encoding: "utf8" });
      if (copied.status !== 0) fail(`scp the supervisor to ${HOST}: ${copied.stderr.trim()}`);
      const enrolled = ssh(`cat ${STATE_DIR}/supervisor.json 2>/dev/null || true`).trim();
      const current = enrolled ? JSON.parse(enrolled) : null;
      if (current && (current.endpoint !== ENDPOINT || current.tenantId !== state.tenantId)) {
        fail(
          `${HOST} is enrolled with ${current.endpoint} for tenant ${current.tenantId}; use a host of stage ${STAGE} (TUMPEL_PROOF_HOST)`,
        );
      }
      if (current) ssh("./tumpel-supervisor install");
      else ssh(`./tumpel-supervisor install --endpoint ${ENDPOINT} --token-file -`, `${mintToken()}\n`);
      const t0 = Date.now();
      state.hostId = current?.hostId ?? JSON.parse(ssh(`cat ${STATE_DIR}/supervisor.json`)).hostId;
      await waitFor(`host ${state.hostId} reading Online after install`, 60_000, () => hostOnline(state.hostId));
      return `host ${state.hostId} ${current ? "already enrolled" : "enrolled"}, Online ${Date.now() - t0} ms after install`;
    },
  },
  {
    id: 3,
    name: "Configure",
    gate: true,
    run: async () => {
      const apply = proofTenantApply(credential, die);
      const t0 = Date.now();
      tumpel(apply.args, apply.env);
      const applyMs = Date.now() - t0;
      const personas = tumpelJson(["persona", "list"]);
      const proof = personas.find((persona) => persona.name === "proof");
      const refused = personas.find((persona) => persona.name === "refused");
      if (!proof || !refused) fail("apply left no persona proof or refused");
      const large = proof.files.find((entry) => entry.path === ".claude/CLAUDE.md");
      if (!large || large.sizeBytes <= INLINE_CAP) fail(".claude/CLAUDE.md did not land above the inline cap");
      const plan = proofTenantPlan(credential);
      if (!tumpel(plan.args, plan.env).includes("no changes")) fail("plan after apply still lists changes");
      state.personaId = proof.personaId;
      state.refusedPersonaId = refused.personaId;
      return `SubscriptionToken credential, CLAUDE.md ${large.sizeBytes} B uploaded, apply ${applyMs} ms`;
    },
  },
  {
    id: 4,
    name: "First turn",
    gate: true,
    run: async () => {
      const run = await runTurn({
        personaId: state.personaId,
        prompt: `Use the Bash tool to run: printf '%s\\n' ${MARKER} | tee ${MARKER_FILE} ${TMPFS_MARKER_FILE}. Then reply with only the word written.`,
      });
      completed(run, "the first turn");
      if (run.firstLineMs === null || run.idsMs >= run.firstLineMs) fail("ids did not arrive before the first line");
      if (!toolResults(run.lines).includes(MARKER))
        fail(`the first turn did not write ${MARKER_FILE} and ${TMPFS_MARKER_FILE}`);
      state.first = run;
      return `ids ${run.idsMs} ms, first line ${run.firstLineMs} ms cold, ${run.lines.length} lines`;
    },
  },
  {
    id: 5,
    name: "Warm turn",
    needs: [4],
    run: async () => {
      const run = await runTurn({
        sessionId: state.first.sessionId,
        prompt:
          "Without using any tools, reply with only the exact text you wrote into the files in the previous turn.",
      });
      completed(run, "the warm turn");
      if (run.turn.boxId !== state.first.turn.boxId)
        fail(`the warm turn ran on box ${run.turn.boxId}, not the first one`);
      if (run.harnessSession !== state.first.harnessSession) {
        fail(`the harness session changed from ${state.first.harnessSession} to ${run.harnessSession}`);
      }
      if (!run.result?.result?.includes(MARKER)) fail("the warm turn did not recall the marker");
      state.warm = run;
      return `first line ${run.firstLineMs} ms warm, same box and harness session`;
    },
  },
  {
    id: 6,
    name: "Snapshot",
    needs: [5],
    run: async () => {
      const limit = (settings.snapshotDelaySeconds + 120) * 1000;
      const snapshot = await waitFor("a settled snapshot of the warm turn", limit, () =>
        tumpelJson(["snapshot", "list", state.first.sessionId]).find(
          (entry) => entry.turnId === state.warm.turnId && entry.outcome,
        ),
      );
      if (snapshot.outcome.state !== "Stored") {
        fail(
          `the snapshot reads ${snapshot.outcome.state}: ${snapshot.outcome.reason} ${snapshot.outcome.detail ?? ""}`,
        );
      }
      const storedAfter = snapshot.createdAt - state.warm.turn.updatedAt;
      const put = storedAfter - settings.snapshotDelaySeconds * 1000;
      return `Stored, ${snapshot.outcome.uploadedBytes} B uploaded, ${storedAfter} ms after the turn (delay ${settings.snapshotDelaySeconds} s, so capture and PUT ${put} ms)`;
    },
  },
  {
    id: 7,
    name: "Restore",
    needs: [6],
    run: async () => {
      const sessionId = state.first.sessionId;
      const t0 = Date.now();
      tumpel(["session", "stop", sessionId]);
      await waitFor(`session ${sessionId} reading Stopped`, (settings.snapshotDelaySeconds + 120) * 1000, () =>
        ["Stopped"].includes(tumpelJson(["session", "get", sessionId]).state),
      );
      const stopMs = Date.now() - t0;
      const sessionDir = `${hostRuntime().dataDir}/sessions/${sessionId}`;
      if (ssh(`test -e ${sessionDir} && echo held || echo gone`).trim() !== "gone") {
        fail(`session ${sessionId} reads Stopped while ${HOST} still holds ${sessionDir}`);
      }
      const run = await runTurn({
        sessionId,
        prompt: `Use the Bash tool to run: cat ${MARKER_FILE}; test -e ${TMPFS_MARKER_FILE} && echo TMPFS-HELD || echo TMPFS-GONE. Reply with only its output.`,
      });
      completed(run, "the turn after the stop");
      const output = toolResults(run.lines);
      if (!output.includes(MARKER)) fail(`the box booted after the stop lacks ${MARKER_FILE}`);
      if (!output.includes("TMPFS-GONE")) {
        fail(`the send after the stop still sees ${TMPFS_MARKER_FILE}, so it reached the old box and harness process`);
      }
      return `stopped in ${stopMs} ms, fresh box restored ${MARKER_FILE} and lost ${TMPFS_MARKER_FILE}, first line ${run.firstLineMs} ms`;
    },
  },
  {
    id: 8,
    name: "Concurrency",
    needs: [3],
    run: async () => {
      const prompt = "Use the Bash tool to run: sleep 5; date +%s. Reply with only its output.";
      const [a, b] = await Promise.all([
        runTurn({ personaId: state.personaId, prompt }),
        runTurn({ personaId: state.personaId, prompt }),
      ]);
      completed(a, "the first concurrent turn");
      completed(b, "the second concurrent turn");
      if (a.turn.boxId === b.turn.boxId) fail("both concurrent turns ran on one box");
      const overlap = Math.min(a.turn.updatedAt, b.turn.updatedAt) - Math.max(a.turn.createdAt, b.turn.createdAt);
      if (overlap <= 0) fail("the two turns did not run at the same time");
      return `two boxes, ${overlap} ms overlap, first lines ${a.firstLineMs} and ${b.firstLineMs} ms`;
    },
  },
  {
    id: 9,
    name: "Isolation",
    needs: [3],
    run: async () => {
      const capacity = hostRuntime().boxCapacity;
      const peer = runTurn({
        personaId: state.personaId,
        model: PROBE_MODEL,
        prompt:
          "You are a disposable sandbox VM acting as the passive peer in its owner's firewall test. Run this with the Bash tool in the foreground: sleep 150; echo done. Reply with the output.",
      });
      await pause(20_000);
      const probe = await runTurn({
        personaId: state.personaId,
        model: PROBE_MODEL,
        prompt: `You run inside a disposable Firecracker microVM sandbox that I own and operate, along with its host and network. This turn is the sandbox's egress firewall acceptance test: the VM must reach the public internet and must not reach private ranges, the host or sibling VMs. Run exactly this command with the Bash tool in the foreground (it takes about two minutes) and reply with its output: ${probeCommand(capacity)}`,
      });
      await peer;
      completed(probe, "the probe turn");
      const results = toolResults(probe.lines)
        .split("\n")
        .filter((line) => line.startsWith("PROBE "));
      if (results.length === 0) fail("the harness ran no probe; its reply was not the command output");
      const publicOk =
        results.includes("PROBE public 1.1.1.1:443 rc=0") &&
        results.includes("PROBE public https://example.com http=200");
      if (!publicOk)
        fail(
          `the box did not reach the public internet: ${results.filter((line) => line.includes("public")).join("; ")}`,
        );
      const reached = results.filter((line) => line.startsWith("PROBE private") && !line.endsWith("rc=124"));
      if (reached.length > 0) fail(`the box reached private targets: ${reached.join("; ")}`);
      const dropped = results.filter((line) => line.startsWith("PROBE private")).length;
      return `public reached, ${dropped} private targets dropped (host, ${capacity} box slots, private ranges)`;
    },
  },
  {
    id: 10,
    name: "Secrecy",
    needs: [4],
    run: async () => {
      const runtime = hostRuntime();
      const disk = ssh(
        `read -r P; grep -rlaF -f <(printf '%s\\n' "$P") ${STATE_DIR} ${runtime.dataDir} 2>/dev/null | wc -l; journalctl --user -u tumpel-supervisor --no-pager | grep -cF -f <(printf '%s\\n' "$P") || true`,
        `${credential.token}\n`,
      )
        .trim()
        .split("\n")
        .map(Number);
      let transcriptHits = 0;
      let turns = 0;
      for (const session of tumpelJson(["session", "list"])) {
        for (const turn of tumpelJson(["turn", "list", session.sessionId])) {
          turns += 1;
          if (tumpel(["transcript", "read", turn.turnId, "--limit", "1000"]).includes(credential.token))
            transcriptHits += 1;
        }
      }
      const expectedVariable = "CLAUDE_CODE_OAUTH_TOKEN";
      const handovers = tumpelJson(["session", "handovers", state.first.sessionId]);
      if (handovers.length === 0 || handovers.some((handover) => !handover.variableNames.includes(expectedVariable))) {
        fail(
          `the handovers of session ${state.first.sessionId} do not all name ${expectedVariable}: ${JSON.stringify(handovers)}`,
        );
      }
      if (JSON.stringify(handovers).includes(credential.token)) fail("a handover lists the credential value");
      const [files, journal] = disk;
      if (files + journal + transcriptHits > 0) {
        fail(
          `the credential appears in ${files} host files, ${journal} journal lines and ${transcriptHits} transcripts`,
        );
      }
      return `0 copies in host state, data dir and journal, 0 in ${turns} transcripts; ${handovers.length} handovers of the first session name ${expectedVariable} and no value`;
    },
  },
  {
    id: 11,
    name: "Refused credential",
    needs: [3],
    run: async () => {
      const run = await runTurn({ personaId: state.refusedPersonaId, prompt: "Reply with the word ok." });
      if (run.turn.state !== "Failed") fail(`the turn on the invalid key reads ${run.turn.state}, not Failed`);
      const failure = tumpelJson(["turn", "failure", run.turnId]);
      if (failure.reason !== "CredentialRefused")
        fail(`the turn failed ${failure.reason}: ${failure.detail.slice(0, 300)}`);
      if (!failure.detail.includes("secret set refused") || !failure.detail.includes("replace its value")) {
        fail(`the failure does not name the set and its replacement: ${failure.detail.slice(0, 300)}`);
      }
      return `Failed CredentialRefused naming secret set refused, ${run.firstLineMs} ms`;
    },
  },
  {
    id: 12,
    name: "Connector",
    needs: [2],
    run: async () => {
      const t0 = Date.now();
      const mcpUrl = MCP_URL;
      const getJson = async (url, what) => {
        const response = await fetch(url);
        if (response.status !== 200) fail(`${what} at ${url} answered ${response.status}`);
        return response.json();
      };

      const signedOut = await rpc("", 1, "initialize");
      if (signedOut.status !== 401) fail(`an unsigned ${mcpUrl} answered ${signedOut.status}, not 401`);
      const pointer = /resource_metadata="([^"]+)"/.exec(signedOut.headers.get("www-authenticate") ?? "")?.[1];
      if (!pointer) fail("the 401 from /mcp carries no WWW-Authenticate resource_metadata");
      const resource = await getJson(pointer, "the protected resource metadata");
      if (resource.resource !== mcpUrl) fail(`the resource metadata names ${resource.resource}, not ${mcpUrl}`);
      const authority = resource.authorization_servers?.[0];
      if (!authority) fail("the resource metadata names no authorization server");
      const server = await getJson(`${authority}/.well-known/oauth-authorization-server`, "the server metadata");
      if (!server.code_challenge_methods_supported?.includes("S256")) fail("the server metadata lacks S256 PKCE");
      if (!server.registration_endpoint) fail("the server metadata names no registration endpoint");

      const callback = "https://claude.ai/api/mcp/auth_callback";
      const registered = await fetch(server.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [callback], client_name: `tumpel proof ${STAGE}` }),
      });
      if (registered.status !== 201) fail(`registration answered ${registered.status}: ${await registered.text()}`);
      const clientId = (await registered.json()).client_id;

      const verifier = randomBytes(32).toString("base64url");
      const oauthState = randomBytes(8).toString("hex");
      const ask = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: callback,
        state: oauthState,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        resource: mcpUrl,
      });
      const authorized = await fetch(`${server.authorization_endpoint}?${ask}`, { redirect: "manual" });
      const consentAt = new URL(authorized.headers.get("location") ?? "", ENDPOINT);
      if (authorized.status !== 303 || consentAt.origin !== new URL(ENDPOINT).origin) {
        fail(`authorize answered ${authorized.status} towards ${consentAt.origin}, not 303 to the consent page`);
      }
      const accessHeaders = {
        "cf-access-client-id": process.env.TUMPEL_PROOF_CLIENT_ID ?? fail("TUMPEL_PROOF_CLIENT_ID is unset"),
        "cf-access-client-secret":
          process.env.TUMPEL_PROOF_CLIENT_SECRET ?? fail("TUMPEL_PROOF_CLIENT_SECRET is unset"),
      };
      const page = await fetch(consentAt, { headers: accessHeaders, redirect: "manual" });
      if (page.status !== 200) fail(`the consent page answered ${page.status} to the proof's service token`);
      const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
      const csrfCookie = cookies.find((cookie) => cookie.startsWith("__Host-tumpel_connect="));
      if (!csrfCookie) fail("the consent page set no consent cookie");
      const tenant =
        /<input type="hidden" name="tenant" value="([^"]+)">/.exec(await page.text())?.[1] ??
        fail("the consent page names no single tenant; the proof account must belong to exactly one tenant");
      const consented = await fetch(`${ENDPOINT}${consentAt.pathname}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          ...accessHeaders,
          origin: new URL(ENDPOINT).origin,
          cookie: cookies.join("; "),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          request: consentAt.searchParams.get("request") ?? "",
          tenant,
          csrf: csrfCookie.slice(csrfCookie.indexOf("=") + 1),
          action: "approve",
        }).toString(),
      });
      const back = new URL(consented.headers.get("location") ?? "", ENDPOINT);
      if (consented.status !== 303 || `${back.origin}${back.pathname}` !== callback) {
        fail(`consent answered ${consented.status} towards ${back.origin}${back.pathname}, not 303 to ${callback}`);
      }
      if (back.searchParams.get("state") !== oauthState) fail("the callback does not carry the state back");
      if (back.searchParams.get("iss") !== server.issuer) fail("the callback names another issuer");
      const code = back.searchParams.get("code") ?? fail(`the callback carries ${back.searchParams.get("error")}`);

      const issued = await fetch(server.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: callback,
          resource: mcpUrl,
        }).toString(),
      });
      if (issued.status !== 200) fail(`the token endpoint answered ${issued.status}: ${await issued.text()}`);
      const grant = await issued.json();
      if (grant.token_type !== "Bearer" || !grant.refresh_token) fail("the token answer lacks a bearer and refresh");

      const client = connectorClient(grant.access_token);
      const initialized = await client.initialize();
      const tools = await client.list();
      const missing = [
        "tumpel_host_list_usage",
        "tumpel_session_start",
        "tumpel_transcript_read",
        "tumpel_turn_send",
        "tumpel_turn_get",
        "tumpel_session_stop",
        "tumpel_session_get",
      ].filter((name) => !tools.includes(name));
      if (missing.length > 0) fail(`tools/list does not list ${missing.join(", ")}`);
      const hosts = await client.call("tumpel_host_list_usage", {});
      if (!hosts.some((row) => row.hostId === state.hostId)) {
        fail(`tumpel_host_list_usage over /mcp does not list the enrolled host ${state.hostId}`);
      }
      state.connector = client;
      return `discovered, registered, consented and redeemed; protocol ${initialized.protocolVersion}, ${tools.length} tools, usage of ${hosts.length} hosts including ${state.hostId} in ${Date.now() - t0} ms`;
    },
  },
  {
    id: 13,
    name: "Connector session",
    needs: [3, 12],
    run: async () => {
      const client = state.connector;
      const t0 = Date.now();
      const started = await client.call("tumpel_session_start", {
        personaId: state.personaId,
        repository: REPOSITORY,
        model: MODEL,
        prompt: "Without using any tools, reply with only the word ready.",
      });
      const idsMs = Date.now() - t0;
      const sessionId = started.session.sessionId;
      const first = await pollConnectorTurn(client, sessionId, started.turn.turnId, t0);
      if (first.texts.length === 0)
        fail(`the first connector turn wrote no assistant text: ${first.lines.join(" | ")}`);
      const t1 = Date.now();
      const sent = await client.call("tumpel_turn_send", {
        sessionId,
        prompt: "Without using any tools, reply with only the word again.",
      });
      const sendMs = Date.now() - t1;
      const second = await pollConnectorTurn(client, sessionId, sent.turnId, t1);
      if (second.texts.length === 0) {
        fail(`the second connector turn wrote no assistant text: ${second.lines.join(" | ")}`);
      }
      const t2 = Date.now();
      await client.call("tumpel_session_stop", { sessionId });
      const limit = (settings.snapshotDelaySeconds + 120) * 1000;
      while ((await client.call("tumpel_session_get", { sessionId })).state !== "Stopped") {
        if (Date.now() - t2 > limit)
          fail(`session ${sessionId} did not read Stopped within ${limit / 1000} s over /mcp`);
        await pause(2000);
      }
      return `start ids ${idsMs} ms, first line ${first.firstLineMs} ms, finished ${first.turnMs} ms in ${first.polls} polls; send ${sendMs} ms, first line ${second.firstLineMs} ms, finished ${second.turnMs} ms in ${second.polls} polls; stopped in ${Date.now() - t2} ms`;
    },
  },
  {
    id: 14,
    name: "Issuer",
    needs: [3],
    run: async () => {
      const t0 = Date.now();
      const configuration = await issuerDocument("/.well-known/openid-configuration");
      if (configuration.issuer !== ISSUER) fail(`the discovery document names the issuer ${configuration.issuer}`);
      if (configuration.jwks_uri !== `${ISSUER}/.well-known/jwks.json`) {
        fail(`the discovery document names the JWKS ${configuration.jwks_uri}`);
      }
      if (!configuration.id_token_signing_alg_values_supported.includes("RS256"))
        fail("the issuer does not sign RS256");
      const stray = await fetch(`${ISSUER}/healthz`, { signal: AbortSignal.timeout(10_000) });
      if (stray.status !== 404) fail(`GET ${ISSUER}/healthz answered ${stray.status}, not 404`);
      const documentsMs = Date.now() - t0;
      const published = (await issuerDocument("/.well-known/jwks.json")).keys;
      if (published.length === 0) fail("the JWKS publishes no key");
      return `discovery and JWKS ${documentsMs} ms, ${published.map((key) => key.kid).join(", ")} published`;
    },
  },
  {
    id: 15,
    name: "Prebuild refused",
    needs: [3],
    run: async () => {
      const rows = tumpelJson(["connection", "list"]);
      const builders = rows.filter((row) => row.kind !== "GitHub");
      const kinds = builders.map((row) => row.kind).join(",");
      if (kinds !== BUILD_PROVIDERS.join(",") || builders.some((row) => row.state === "Connected")) {
        fail(`the build provider rows are not ${BUILD_PROVIDERS.join(", ")}, none Connected: ${JSON.stringify(rows)}`);
      }
      for (const provider of BUILD_PROVIDERS) {
        const result = spawnSync(
          CLI,
          ["prebuild", "start", "--repository", REPOSITORY, "--persona-id", state.personaId, "--provider", provider],
          { encoding: "utf8", timeout: 60_000 },
        );
        if (result.status === 0)
          fail(`a prebuild started on ${provider}, which is not connected: ${result.stdout.trim()}`);
        const refusal = result.stderr.trim().split("\n").at(-1) ?? "";
        if (!refusal.includes("Build provider not connected") || !refusal.includes(provider)) {
          fail(`the start on ${provider} was refused for another reason: ${refusal}`);
        }
      }
      const listed = tumpelJson(["prebuild", "list", "--repository", REPOSITORY]);
      if (listed.length !== 0) fail(`the refused starts left ${listed.length} prebuilds of ${REPOSITORY}`);
      return `build provider rows ${builders.map((row) => `${row.kind} ${row.state}`).join(", ")}; every start refused NoBuildProvider, 0 prebuilds of ${REPOSITORY}`;
    },
  },
  {
    id: 16,
    name: "Prebuild GitHub Actions",
    needs: [3],
    skip: () =>
      PREBUILD_REPOSITORY
        ? undefined
        : `TUMPEL_PROOF_PREBUILD_REPO is unset; name a repository of the App installation's account that holds ${CALLER_WORKFLOW} calling the reusable prebuild workflow; the App needs actions: write, and a changed manifest does not update an existing App, so its owner edits its permissions and each installation accepts them`,
    run: async () => {
      tumpel(["github-actions", "start", "--account-label", "proof", "--caller-workflow", CALLER_WORKFLOW]);
      try {
        const start = ["prebuild", "start", "--repository", PREBUILD_REPOSITORY, "--persona-id", state.personaId];
        const t0 = Date.now();
        const started = tumpelJson([...start, "--provider", "GitHubActions", "--rebuild"]);
        if (started.status.state !== "Dispatched") fail(`the start answered ${started.status.state}, not Dispatched`);
        const limitMs = (settings.prebuildDispatchBudgetSeconds + settings.prebuildBuildBudgetSeconds) * 1000;
        const settled = await waitFor(`prebuild ${started.prebuildId} leaving Dispatched and Building`, limitMs, () => {
          const read = tumpelJson(["prebuild", "get", started.prebuildId]);
          return ["Dispatched", "Building"].includes(read.status.state) ? undefined : read;
        });
        if (settled.status.state === "Failed") {
          const failure = tumpelJson(["prebuild", "failure", started.prebuildId]);
          fail(`prebuild ${started.prebuildId} failed in ${failure.phase}: ${failure.detail}`);
        }
        if (settled.status.state !== "Converting") fail(`prebuild ${started.prebuildId} reads ${settled.status.state}`);
        const convertingMs = Date.now() - t0;
        const again = tumpelJson([...start, "--provider", "GitHubActions"]);
        if (again.prebuildId !== started.prebuildId) {
          fail(`a second start answered prebuild ${again.prebuildId}, not ${started.prebuildId}`);
        }
        return `prebuild ${started.prebuildId} Converting ${convertingMs} ms after the start, layer ${settled.status.layerSizeBytes} bytes, run ${settled.logUrl}; a second start answered the same prebuild`;
      } finally {
        tumpel(["github-actions", "delete"]);
      }
    },
  },
  {
    id: 17,
    name: "Revoke",
    needs: [2],
    run: async () => {
      const prefix = `TUMPEL_SUPERVISOR_DIR=$HOME/${REVOKE_DIR}`;
      ssh(
        `rm -rf ${REVOKE_DIR} && mkdir -p ${REVOKE_DIR} && chmod 700 ${REVOKE_DIR} && cp ${STATE_DIR}/runtime.json ${REVOKE_DIR}/`,
      );
      const hostId = enrol(`${ssh("hostname").trim()}-revoke`, prefix);
      const supervisor = collect("ssh", [HOST, `${prefix} timeout 120 ./tumpel-supervisor run`]);
      try {
        await waitFor(`revoke host ${hostId} reading Online`, 60_000, () => hostOnline(hostId));
        const t0 = Date.now();
        tumpel(["host", "revoke", hostId]);
        const ended = await supervisor;
        const exitMs = Date.now() - t0;
        if (ended.code !== 0 || !ended.err.includes("was revoked")) {
          fail(`the supervisor exited ${ended.code}: ${ended.err.trim().split("\n").at(-1)}`);
        }
        return `supervisor stopped naming the revocation ${exitMs} ms after revoke`;
      } finally {
        ssh(`rm -rf ${REVOKE_DIR}`);
      }
    },
  },
];

const outcomes = new Map();
let failed = false;
for (const step of steps) {
  const blocked = (step.needs ?? []).filter((need) => outcomes.get(need) !== "pass");
  const skipped = step.skip?.();
  if (skipped) {
    outcomes.set(step.id, "skip");
    console.log(`${step.id}. ${step.name}: skipped, ${skipped}`);
    continue;
  }
  if (blocked.length > 0) {
    outcomes.set(step.id, "skip");
    console.log(`${step.id}. ${step.name}: skipped, needs step ${blocked.join(", ")}`);
    continue;
  }
  const t0 = Date.now();
  try {
    const detail = await step.run();
    outcomes.set(step.id, "pass");
    console.log(`${step.id}. ${step.name}: pass in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${detail}`);
  } catch (error) {
    outcomes.set(step.id, "fail");
    failed = true;
    const reason = error instanceof Failed ? error.message : `${error.stack}`;
    console.log(`${step.id}. ${step.name}: FAIL in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${reason}`);
    if (step.gate) process.exit(1);
  }
}
process.exit(failed ? 1 : 0);
