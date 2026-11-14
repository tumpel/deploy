#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORK = join(ROOT, ".tmp", "proof-e2e");
const STAGE = process.env.TUMPEL_STAGE ?? "dev";
const HOST = process.env.TUMPEL_PROOF_HOST ?? "tumpel-host";
const ENDPOINT = process.env.TUMPEL_PROOF_ENDPOINT;
const TENANT = process.env.TUMPEL_PROOF_TENANT ?? "Tumpel proof";
const CREDENTIAL = process.env.TUMPEL_PROOF_CREDENTIAL ?? "dotfiles:claude-setup-token-personal";
const REPOSITORY = process.env.TUMPEL_PROOF_REPOSITORY ?? "https://github.com/mvhenten/drawio-headless.git";
const MODEL = process.env.TUMPEL_PROOF_MODEL ?? "claude-haiku-4-5";
const PROBE_MODEL = process.env.TUMPEL_PROOF_PROBE_MODEL ?? "claude-sonnet-4-5";
const CLI = process.env.TUMPEL_CLI ?? join(ROOT, "target", "release", "tumpel");
const SUPERVISOR =
  process.env.TUMPEL_PROOF_SUPERVISOR ??
  join(ROOT, "target", "x86_64-unknown-linux-gnu", "release", "tumpel-supervisor");
const STATE_DIR = ".local/state/tumpel-supervisor";
const REVOKE_DIR = "development/.tmp/tumpel-proof-revoke";
const INLINE_CAP = 65_536;
const MARKER = `tumpel-proof-${randomBytes(4).toString("hex")}`;

const die = (message) => {
  console.error(`proof:e2e: ${message}`);
  process.exit(1);
};

if (!ENDPOINT) die("TUMPEL_PROOF_ENDPOINT is unset; run this through npm run proof:e2e, which sets it from the stage");
if (!existsSync(CLI)) die(`${CLI} is missing; build it with cargo build --release -p tumpel`);
if (!existsSync(SUPERVISOR)) die(`${SUPERVISOR} is missing; build it with npm run supervisor:build`);

const config = JSON.parse(
  readFileSync(join(ROOT, "packages", "control-plane", "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
);
const settings = (config.env?.[STAGE]?.vars ?? config.vars).TUMPEL_SETTINGS;

class Failed extends Error {}
const fail = (message) => {
  throw new Failed(message);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loadCredential = () => {
  const [source, ...rest] = CREDENTIAL.split(":");
  const reference = rest.join(":");
  if (source === "dotfiles") {
    const dir = mkdtempSync(join(WORK, "credential-"));
    const file = join(dir, "value");
    const result = spawnSync("dotfiles-key", ["decrypt", reference, "-o", file], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (result.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      die(`dotfiles-key decrypt ${reference} exited ${result.status}; run dotfiles-key unlock`);
    }
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    rmSync(dir, { recursive: true });
    const assigned = lines.find((line) => /^[A-Z_]+=/.test(line));
    const value = assigned ? assigned.slice(assigned.indexOf("=") + 1) : lines[0];
    if (!value) die(`dotfiles key ${reference} is empty`);
    const subscription = value.startsWith("sk-ant-oat");
    return {
      value,
      kind: subscription ? "SubscriptionToken" : "ApiKey",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }
  if (source === "claude-credentials") {
    const path = reference || join(homedir(), ".claude", ".credentials.json");
    const oauth = JSON.parse(readFileSync(path, "utf8")).claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.expiresAt) die(`${path} holds no claudeAiOauth access token with its expiry`);
    return { value: oauth.accessToken, kind: "SubscriptionToken", expiresAt: new Date(oauth.expiresAt).toISOString() };
  }
  return die(`TUMPEL_PROOF_CREDENTIAL ${CREDENTIAL} must be dotfiles:<key name> or claude-credentials[:<path>]`);
};

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

const follow = (turnId) =>
  new Promise((resolve) => {
    const child = spawn(CLI, ["transcript", "read", turnId, "--follow"], { stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("close", (code) => resolve({ code, firstAt, lines: out.split("\n").filter(Boolean), err }));
  });

const runTurn = async ({ sessionId, personaId, prompt, model = MODEL }) => {
  const t0 = Date.now();
  const started = await new Promise((resolve) => {
    const args = sessionId
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
        ];
    const child = spawn(CLI, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", (code) => resolve({ code, out, err }));
  });
  const idsMs = Date.now() - t0;
  if (started.code !== 0) fail(`starting the turn: ${started.err.trim().split("\n").at(-1)}`);
  const body = JSON.parse(started.out);
  const turnId = body.turn?.turnId ?? body.turnId;
  const session = body.session?.sessionId ?? body.sessionId ?? sessionId;
  const read = await follow(turnId);
  const turn = tumpelJson(["turn", "get", turnId]);
  const parsed = read.lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return {};
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

const completed = (run, what) => {
  if (run.turn.state === "Completed") return;
  const failure = run.turn.state === "Failed" ? tumpelJson(["turn", "failure", run.turnId]) : null;
  fail(`${what} reads ${run.turn.state}${failure ? ` (${failure.reason}: ${failure.detail.slice(0, 300)})` : ""}`);
};

const hostRuntime = () => JSON.parse(ssh(`cat ${STATE_DIR}/runtime.json`));
const hostOnline = (hostId) =>
  tumpelJson(["host", "list"]).find((host) => host.hostId === hostId && host.state === "Online");

const restartSupervisor = async (hostId) => {
  ssh("systemctl --user restart tumpel-supervisor");
  await waitFor(`host ${hostId} reading Online after a restart`, 60_000, () => hostOnline(hostId));
};

const enrol = (name, envPrefix) => {
  const minted = spawnSync(CLI, ["host", "mint-token", "--expires-in", "600"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (minted.status !== 0) fail(`tumpel host mint-token: ${minted.stderr.trim().split("\n").at(-1)}`);
  const tokenFile = `.tumpel-proof-enrol-${randomBytes(4).toString("hex")}`;
  ssh(`umask 077; cat > ${tokenFile}`, `${minted.stdout.trim()}\n`);
  const out = ssh(
    `${envPrefix} ./tumpel-supervisor enrol --endpoint ${ENDPOINT} --token-file ${tokenFile} --name ${name}; s=$?; rm -f ${tokenFile}; exit $s`,
  );
  return JSON.parse(out.slice(0, out.lastIndexOf("}") + 1)).hostId;
};

const state = {};
const credential = (() => {
  mkdirSync(WORK, { recursive: true });
  return loadCredential();
})();

const writeTenantConfig = () => {
  const files = join(WORK, "files");
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, "settings.json"), `${JSON.stringify({ includeCoAuthoredBy: false }, null, 2)}\n`);
  const lines = ["# Proof persona", "", "Answer briefly. Do what the prompt asks and nothing more.", ""];
  for (let index = 1; lines.join("\n").length <= INLINE_CAP + 4096; index += 1) {
    lines.push(`- Note ${index}: padding that sends this file through the presigned upload route.`);
  }
  writeFileSync(join(files, "CLAUDE.md"), `${lines.join("\n")}\n`);
  const credentialMember =
    credential.kind === "SubscriptionToken"
      ? {
          kind: "SubscriptionToken",
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          provider: "Anthropic",
          expiresAt: credential.expiresAt,
          valueFrom: { env: "PROOF_CREDENTIAL" },
        }
      : { kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", valueFrom: { env: "PROOF_CREDENTIAL" } };
  const tenant = {
    $schema: "https://raw.githubusercontent.com/mvhenten/tumpel/main/packages/api/generated/TenantConfig.json",
    personas: [
      {
        name: "proof",
        harness: "ClaudeCode",
        secretSetName: "proof",
        gitAuthorName: "Tumpel proof",
        gitAuthorEmail: "proof@tumpel.invalid",
        files: [
          { path: ".claude/settings.json", from: "files/settings.json" },
          { path: ".claude/CLAUDE.md", from: "files/CLAUDE.md" },
        ],
      },
      {
        name: "refused",
        harness: "ClaudeCode",
        secretSetName: "refused",
        gitAuthorName: "Tumpel proof",
        gitAuthorEmail: "proof@tumpel.invalid",
        files: [{ path: ".claude/settings.json", from: "files/settings.json" }],
      },
    ],
    secretSets: [
      { name: "proof", secrets: [credentialMember] },
      {
        name: "refused",
        secrets: [
          { kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", valueFrom: { env: "PROOF_REFUSED_KEY" } },
        ],
      },
    ],
    harnessPins: [],
    hosts: [],
  };
  const file = join(WORK, "tumpel.json");
  writeFileSync(file, `${JSON.stringify(tenant, null, 2)}\n`);
  return file;
};

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
      ssh("./tumpel-supervisor install");
      const enrolled = ssh(`cat ${STATE_DIR}/supervisor.json 2>/dev/null || true`).trim();
      const current = enrolled ? JSON.parse(enrolled) : null;
      if (current && (current.endpoint !== ENDPOINT || current.tenantId !== state.tenantId)) {
        fail(
          `${HOST} is enrolled with ${current.endpoint} for tenant ${current.tenantId}; use a host of stage ${STAGE} (TUMPEL_PROOF_HOST)`,
        );
      }
      const t0 = Date.now();
      state.hostId = current?.hostId ?? enrol(ssh("hostname").trim(), "");
      await restartSupervisor(state.hostId);
      return `host ${state.hostId} ${current ? "already enrolled" : "enrolled"}, Online ${Date.now() - t0} ms after start`;
    },
  },
  {
    id: 3,
    name: "Configure",
    gate: true,
    run: async () => {
      const file = writeTenantConfig();
      const t0 = Date.now();
      tumpel(["config", "apply", file, "--rewrite-secrets", "proof", "--rewrite-secrets", "refused"], {
        PROOF_CREDENTIAL: credential.value,
        PROOF_REFUSED_KEY: `proof-invalid-${randomBytes(16).toString("hex")}`,
      });
      const applyMs = Date.now() - t0;
      const personas = tumpelJson(["persona", "list"]);
      const proof = personas.find((persona) => persona.name === "proof");
      const refused = personas.find((persona) => persona.name === "refused");
      if (!proof || !refused) fail("apply left no persona proof or refused");
      const large = proof.files.find((entry) => entry.path === ".claude/CLAUDE.md");
      if (!large || large.sizeBytes <= INLINE_CAP) fail(".claude/CLAUDE.md did not land above the inline cap");
      if (!tumpel(["config", "plan", file]).includes("no changes")) fail("plan after apply still lists changes");
      state.personaId = proof.personaId;
      state.refusedPersonaId = refused.personaId;
      return `${credential.kind} credential, CLAUDE.md ${large.sizeBytes} B uploaded, apply ${applyMs} ms`;
    },
  },
  {
    id: 4,
    name: "First turn",
    gate: true,
    run: async () => {
      const run = await runTurn({
        personaId: state.personaId,
        prompt: `Write the text ${MARKER} into a new file named /root/proof-marker.txt, then reply with only the word written.`,
      });
      completed(run, "the first turn");
      if (run.firstLineMs === null || run.idsMs >= run.firstLineMs) fail("ids did not arrive before the first line");
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
        prompt: "Without using any tools, reply with only the exact text you wrote into the file in the previous turn.",
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
      return `Stored ${snapshot.outcome.sizeBytes} B, ${storedAfter} ms after the turn (delay ${settings.snapshotDelaySeconds} s, so capture and PUT ${put} ms)`;
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
        prompt: "Use the Bash tool to run: cat /root/proof-marker.txt. Reply with only its output, or MISSING.",
      });
      completed(run, "the turn after the stop");
      if (!run.lines.join("\n").includes(MARKER)) fail("the box booted after the stop lacks /root/proof-marker.txt");
      if (run.harnessSession === state.warm.harnessSession)
        fail("the send after the stop reached the old harness process");
      return `stopped in ${stopMs} ms, fresh box restored the file, first line ${run.firstLineMs} ms`;
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
      const results = probe.lines
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
        .join("\n")
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
        `${credential.value}\n`,
      )
        .trim()
        .split("\n")
        .map(Number);
      let transcriptHits = 0;
      let turns = 0;
      for (const session of tumpelJson(["session", "list"])) {
        for (const turn of tumpelJson(["turn", "list", session.sessionId])) {
          turns += 1;
          if (tumpel(["transcript", "read", turn.turnId, "--limit", "1000"]).includes(credential.value))
            transcriptHits += 1;
        }
      }
      const [files, journal] = disk;
      if (files + journal + transcriptHits > 0) {
        fail(
          `the credential appears in ${files} host files, ${journal} journal lines and ${transcriptHits} transcripts`,
        );
      }
      return `0 copies in host state, data dir and journal, 0 in ${turns} transcripts; audit not readable through the API`;
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
      if (!failure.detail.includes("secret set refused") || !failure.detail.includes("--rewrite-secrets refused")) {
        fail(`the failure does not name the set and its replacement: ${failure.detail.slice(0, 300)}`);
      }
      return `Failed CredentialRefused naming secret set refused, ${run.firstLineMs} ms`;
    },
  },
  {
    id: 12,
    name: "Revoke",
    needs: [2],
    run: async () => {
      const prefix = `TUMPEL_SUPERVISOR_DIR=$HOME/${REVOKE_DIR}`;
      ssh(
        `rm -rf ${REVOKE_DIR} && mkdir -p ${REVOKE_DIR} && chmod 700 ${REVOKE_DIR} && cp ${STATE_DIR}/runtime.json ${REVOKE_DIR}/`,
      );
      const hostId = enrol(`${ssh("hostname").trim()}-revoke`, prefix);
      const supervisor = new Promise((resolve) => {
        const child = spawn("ssh", [HOST, `${prefix} timeout 120 ./tumpel-supervisor run`], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (chunk) => {
          err += chunk;
        });
        child.on("close", (code) => resolve({ code, err }));
      });
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
