#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GIT = "/usr/bin/git";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WORK_START = 8 * 3600;
const WORK_END = 22 * 3600;
const NIGHT_SPAN = 7 * 3600;
const COMMANDS = /^(?:commit|tag|reset|blob|progress|checkpoint|feature|option|done)\b/;
const TOKEN_SHAPES = [
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["openrouter-key", /\bsk-or-v1-[0-9a-f]{64}\b/],
  ["cloudflare-token", /\bcf(?:k|ut|at)_[A-Za-z0-9_-]{30,}/],
  ["cloudflare-token", /CLOUDFLARE_API_(?:TOKEN|KEY)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{37,}/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe-key", /\b[sr]k_live_[0-9A-Za-z]{20,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;

const expand = (path) => path.replace(/^~(?=\/)/, homedir());
const sha = (text) => createHash("sha256").update(text).digest();
const seeded = (seed, key) => sha(`${seed}\0${key}`).readUInt32BE(0) / 2 ** 32;
const git = (cwd, args, options = {}) =>
  execFileSync(GIT, args, { cwd, encoding: "utf8", maxBuffer: 1 << 30, ...options });

const globRegex = (glob) =>
  new RegExp(
    `^${glob
      .split(/(\*\*\/|\*\*|\*)/)
      .map((part) =>
        part === "**/"
          ? "(?:.*/)?"
          : part === "**"
            ? ".*"
            : part === "*"
              ? "[^/]*"
              : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("")}$`,
  );

const compileRule = (rule) => ({
  ...rule,
  regex: new RegExp(rule.pattern, `g${rule.flags ?? ""}`),
  detector: new RegExp(rule.detect ?? rule.pattern, `g${rule.flags ?? ""}`),
});

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const loadLiterals = (path) => {
  if (!path || !existsSync(expand(path))) return [];
  const entries = JSON.parse(readFileSync(expand(path), "utf8"));
  return entries.map((entry, index) =>
    compileRule({
      name: entry.name ?? `literal-${index + 1}`,
      pattern: escapeRegex(entry.literal),
      replacement: entry.replacement ?? "REDACTED",
    }),
  );
};

const parseArgs = (argv) => {
  const args = { config: join(HERE, "split.config.json"), rules: join(HERE, "scrub-rules.json"), only: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--config") args.config = argv[++index];
    else if (flag === "--rules") args.rules = argv[++index];
    else if (flag === "--source") args.source = argv[++index];
    else if (flag === "--output") args.output = argv[++index];
    else if (flag === "--only") args.only.push(argv[++index]);
    else {
      console.error(
        "usage: split.mjs [--config file] [--rules file] [--source url-or-path] [--output dir] [--only repo]...",
      );
      process.exit(2);
    }
  }
  return args;
};

class StreamReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.chunks = [];
    this.length = 0;
    this.pending = [];
  }

  async fill() {
    const { value, done } = await this.iterator.next();
    if (done) return false;
    this.chunks.push(value);
    this.length += value.length;
    return true;
  }

  flatten() {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  take(count) {
    const buffer = this.flatten();
    const taken = buffer.subarray(0, count);
    const rest = buffer.subarray(count);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return taken;
  }

  unread(line) {
    this.pending.push(line);
  }

  async line() {
    if (this.pending.length) return this.pending.pop();
    for (;;) {
      for (let scanned = 0, index = 0; index < this.chunks.length; index += 1) {
        const newline = this.chunks[index].indexOf(10);
        if (newline >= 0) {
          const line = this.take(scanned + newline + 1).toString("utf8");
          return line.slice(0, -1);
        }
        scanned += this.chunks[index].length;
      }
      if (!(await this.fill())) {
        if (this.length === 0) return null;
        return this.take(this.length).toString("utf8");
      }
    }
  }

  async bytes(count) {
    while (this.length < count) {
      if (!(await this.fill())) throw new Error(`stream ended ${count - this.length} bytes early`);
    }
    return this.take(count);
  }
}

class BlobReader {
  constructor(repo) {
    this.child = spawn(GIT, ["cat-file", "--batch"], { cwd: repo, stdio: ["pipe", "pipe", "inherit"] });
    this.reader = new StreamReader(this.child.stdout);
    this.queue = Promise.resolve();
  }

  read(object) {
    const result = this.queue.then(async () => {
      this.child.stdin.write(`${object}\n`);
      const header = await this.reader.line();
      const [, type, size] = header.split(" ");
      if (type === undefined || size === undefined) throw new Error(`cat-file cannot read ${object}: ${header}`);
      const content = await this.reader.bytes(Number(size));
      await this.reader.bytes(1);
      return { type, content };
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  close() {
    this.child.stdin.end();
  }
}

class Writer {
  constructor(stream) {
    this.stream = stream;
  }

  async write(data) {
    if (!this.stream.write(data)) await new Promise((resolve) => this.stream.once("drain", resolve));
  }
}

const unquotePath = (raw) => {
  if (!raw.startsWith('"')) return raw;
  const bytes = [];
  const escapes = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw[index];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = raw[index + 1];
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(raw.slice(index + 1, index + 4), 8));
      index += 3;
      continue;
    }
    bytes.push(escapes[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
};

const quotePath = (path) =>
  /["\\\n]|^"/.test(path) || /[^\x20-\x7e]/.test(path)
    ? `"${[...Buffer.from(path, "utf8")]
        .map((byte) =>
          byte === 34
            ? '\\"'
            : byte === 92
              ? "\\\\"
              : byte === 10
                ? "\\n"
                : byte < 32 || byte > 126
                  ? `\\${byte.toString(8).padStart(3, "0")}`
                  : String.fromCharCode(byte),
        )
        .join("")}"`
    : path;

const prefixMatch = (path, key) => (key.endsWith("/") ? path.startsWith(key) : path === key);

const buildClassifier = (config, name, denylist) => {
  const sortedKeep = (repo) => Object.entries(repo.keep ?? {}).sort(([a], [b]) => b.length - a.length);
  const mapWith = (repo, path) => {
    if ((repo.exclude ?? []).some((key) => prefixMatch(path, key))) return null;
    const match = sortedKeep(repo).find(([from]) => prefixMatch(path, from));
    return match ? match[1] + path.slice(match[0].length) : null;
  };
  const repo = config.repos[name];
  const others = Object.entries(config.repos).filter(([other, spec]) => other !== name && !spec.rest);
  return (path) => {
    if (config.dropEverywhere.some((key) => prefixMatch(path, key))) return null;
    if (repo.public && denylist.some((regex) => regex.test(path))) return null;
    const mapped = mapWith(repo, path);
    if (mapped !== null) return mapped;
    if (!repo.rest) return null;
    if ((repo.exclude ?? []).some((key) => prefixMatch(path, key))) return null;
    return others.some(([, spec]) => mapWith(spec, path) !== null) ? null : path;
  };
};

const isBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

const applyRules = (text, rules) =>
  rules.reduce((current, rule) => current.replace(rule.regex, rule.replacement), text);

const parseIdent = (line) => {
  const match = line.match(/^(\w+) (.*) (\d+) ([+-]\d{4})$/);
  if (!match) throw new Error(`cannot parse identity line: ${line.slice(0, 40)}`);
  return { kind: match[1], who: match[2], time: Number(match[3]), zone: match[4] };
};

const zoneSeconds = (zone) => {
  const sign = zone.startsWith("-") ? -1 : 1;
  return sign * (Number(zone.slice(1, 3)) * 3600 + Number(zone.slice(3, 5)) * 60);
};

const localParts = (time, zone) => {
  const local = new Date((time + zoneSeconds(zone)) * 1000);
  return {
    weekday: local.getUTCDay(),
    hour: local.getUTCHours(),
    second: local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds(),
  };
};

export const inWorkingHours = (time, zone) => {
  const { weekday, second } = localParts(time, zone);
  return weekday >= 1 && weekday <= 5 && second >= WORK_START && second < WORK_END;
};

const moveOutOfHours = (time, zone, jitter) => {
  if (!inWorkingHours(time, zone)) return time;
  const { second } = localParts(time, zone);
  const target = WORK_END + Math.floor(((second - WORK_START) * NIGHT_SPAN) / (WORK_END - WORK_START) + jitter * 600);
  return time + (target - second);
};

const createClock = (seed) => {
  let previous = 0;
  return {
    commit(author, committer, key) {
      let committed = moveOutOfHours(committer.time, committer.zone, seeded(seed, `${key}:c`));
      if (committed <= previous) committed = previous + 60 + Math.floor(seeded(seed, `${key}:gap`) * 240);
      while (inWorkingHours(committed, committer.zone)) committed = moveOutOfHours(committed, committer.zone, 0);
      previous = committed;
      let authored = moveOutOfHours(author.time, author.zone, seeded(seed, `${key}:a`));
      if (authored > committed) authored = committed;
      if (inWorkingHours(authored, author.zone)) authored -= localParts(authored, author.zone).second - WORK_START + 1;
      return { authored, committed };
    },
    tag(tagger, key) {
      return moveOutOfHours(tagger.time, tagger.zone, seeded(seed, `${key}:t`));
    },
  };
};

const readData = async (reader, header) => {
  const size = Number(header.slice(5));
  if (!header.startsWith("data ") || Number.isNaN(size)) throw new Error(`expected a data header, got ${header}`);
  return reader.bytes(size);
};

const parseCommit = async (reader, ref) => {
  const commit = { ref, parents: [], files: [], deleteall: false };
  for (;;) {
    const line = await reader.line();
    if (line.startsWith("mark ")) commit.mark = line.slice(5);
    else if (line.startsWith("original-oid ")) commit.original = line.slice(13);
    else if (line.startsWith("author ")) commit.author = parseIdent(line);
    else if (line.startsWith("committer ")) commit.committer = parseIdent(line);
    else if (line.startsWith("encoding ")) commit.encoding = line.slice(9);
    else if (line.startsWith("data ")) {
      commit.message = (await readData(reader, line)).toString("utf8");
      break;
    } else throw new Error(`unexpected commit header: ${line.slice(0, 60)}`);
  }
  let body = false;
  for (;;) {
    const line = await reader.line();
    if (line === null) break;
    if (line === "" && !body) continue;
    if (line === "") break;
    if (COMMANDS.test(line)) {
      reader.unread(line);
      break;
    }
    body = true;
    if (line.startsWith("from ") || line.startsWith("merge ")) commit.parents.push(line.split(" ")[1]);
    else if (line === "deleteall") commit.deleteall = true;
    else if (line.startsWith("M ")) {
      const [, mode, object] = line.split(" ", 3);
      const path = unquotePath(line.slice(3 + mode.length + object.length + 1));
      commit.files.push({ mode, object, path });
    } else if (line.startsWith("D ")) commit.files.push({ deleted: true, path: unquotePath(line.slice(2)) });
    else throw new Error(`unexpected commit body line: ${line.slice(0, 60)}`);
  }
  if (!commit.deleteall) throw new Error(`commit ${commit.original} has no deleteall; the export must use --full-tree`);
  return commit;
};

const parseTag = async (reader, name) => {
  const tag = { name };
  for (;;) {
    const line = await reader.line();
    if (line.startsWith("mark ")) tag.mark = line.slice(5);
    else if (line.startsWith("from ")) tag.from = line.slice(5);
    else if (line.startsWith("original-oid ")) tag.original = line.slice(13);
    else if (line.startsWith("tagger ")) tag.tagger = parseIdent(line);
    else if (line.startsWith("data ")) {
      tag.message = (await readData(reader, line)).toString("utf8");
      break;
    } else throw new Error(`unexpected tag header: ${line.slice(0, 60)}`);
  }
  return tag;
};

const identLine = (ident, time) => `${ident.kind} ${ident.who} ${time} ${ident.zone}\n`;
const dataBlock = (buffer) => Buffer.concat([Buffer.from(`data ${buffer.length}\n`), buffer, Buffer.from("\n")]);

const splitRepo = async ({ config, name, source, target, rules, literals }) => {
  const spec = config.repos[name];
  const denylist = (rules.pathDenylist ?? []).map(globRegex);
  const classify = buildClassifier(config, name, denylist);
  const blobRules = spec.public ? [...literals, ...rules.blobRules] : [];
  const messageRules = [
    ...(spec.public ? [...literals, ...rules.blobRules, ...rules.messageRules] : []),
    ...rules.attributionRules,
  ];
  const keepRef = (ref) => ref === `refs/heads/${config.branch}` || (spec.tags && ref.startsWith("refs/tags/"));
  const clock = createClock(`${config.seed}:${name}`);

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  git(target, ["init", "-q", "-b", config.branch]);

  const exporter = spawn(
    GIT,
    [
      "fast-export",
      "--all",
      "--signed-tags=strip",
      "--reencode=yes",
      "--no-data",
      "--full-tree",
      "--show-original-ids",
    ],
    { cwd: source, stdio: ["ignore", "pipe", "inherit"] },
  );
  const importer = spawn(GIT, ["fast-import", "--quiet"], { cwd: target, stdio: ["pipe", "inherit", "inherit"] });
  const importDone = new Promise((resolve, reject) =>
    importer.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`fast-import exited ${code}`)))),
  );
  const reader = new StreamReader(exporter.stdout);
  const writer = new Writer(importer.stdin);
  const blobs = new BlobReader(source);

  const remapped = new Map();
  const trees = new Map();
  const ancestors = new Map();
  const blobMarks = new Map();
  const refTips = new Map();
  const stats = { before: 0, after: 0, empty: 0, retimed: 0, collisions: [] };
  let nextMark = 0;
  const emptyTree = sha("").toString("hex");
  const resolve = (parent) => (parent.startsWith(":") ? (remapped.get(parent) ?? null) : null);

  const blobMark = async (object) => {
    if (blobMarks.has(object)) return blobMarks.get(object);
    const { content } = await blobs.read(object);
    const scrubbed =
      blobRules.length && !isBinary(content)
        ? Buffer.from(applyRules(content.toString("utf8"), blobRules), "utf8")
        : content;
    const mark = `:${++nextMark}`;
    await writer.write(Buffer.concat([Buffer.from(`blob\nmark ${mark}\n`), dataBlock(scrubbed)]));
    blobMarks.set(object, mark);
    return mark;
  };

  const handleCommit = async (commit) => {
    stats.before += 1;
    const unique = [...new Set(commit.parents.map(resolve).filter(Boolean))];
    const parents = unique.filter(
      (parent) => !unique.some((other) => other !== parent && ancestors.get(other).has(parent)),
    );
    const entries = new Map();
    for (const file of commit.files) {
      if (file.deleted) continue;
      const path = classify(file.path);
      if (path === null || path === "") continue;
      if (entries.has(path)) {
        stats.collisions.push(`${file.path} -> ${path}`);
        continue;
      }
      entries.set(path, file);
    }
    const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const tree = sha(sorted.map(([path, file]) => `${file.mode} ${file.object} ${path}`).join("\n")).toString("hex");
    const parentTree = parents.length ? trees.get(parents[0]) : emptyTree;
    if (parents.length <= 1 && tree === parentTree) {
      stats.empty += 1;
      remapped.set(commit.mark, parents[0] ?? null);
      refTips.set(commit.ref, parents[0] ?? null);
      return;
    }
    const marks = [];
    for (const [path, file] of sorted) {
      marks.push([path, file.mode, file.mode === "160000" ? file.object : await blobMark(file.object)]);
    }
    const mark = `:${++nextMark}`;
    const { authored, committed } = clock.commit(commit.author, commit.committer, commit.original ?? commit.mark);
    if (authored !== commit.author.time || committed !== commit.committer.time) stats.retimed += 1;
    const message = messageRules.length ? applyRules(commit.message, messageRules) : commit.message;
    const head = [
      parents.length ? "" : `reset ${commit.ref}\n\n`,
      `commit ${commit.ref}\nmark ${mark}\n`,
      identLine(commit.author, authored),
      identLine(commit.committer, committed),
    ].join("");
    const tail = [
      ...parents.map((parent, index) => `${index === 0 ? "from" : "merge"} ${parent}\n`),
      "deleteall\n",
      ...marks.map(([path, mode, object]) => `M ${mode} ${object} ${quotePath(path)}\n`),
      "\n",
    ].join("");
    await writer.write(Buffer.concat([Buffer.from(head), dataBlock(Buffer.from(message, "utf8")), Buffer.from(tail)]));
    stats.after += 1;
    remapped.set(commit.mark, mark);
    trees.set(mark, tree);
    ancestors.set(mark, new Set(parents.flatMap((parent) => [parent, ...ancestors.get(parent)])));
    refTips.set(commit.ref, mark);
  };

  const handleTag = async (tag) => {
    const target = resolve(tag.from);
    if (!spec.tags || !target) return;
    const time = clock.tag(tag.tagger ?? { time: 0, zone: "+0000" }, tag.name);
    const message = messageRules.length ? applyRules(tag.message, messageRules) : tag.message;
    const tagger = tag.tagger ? identLine(tag.tagger, time) : "";
    await writer.write(
      Buffer.concat([Buffer.from(`tag ${tag.name}\nfrom ${target}\n${tagger}`), dataBlock(Buffer.from(message))]),
    );
  };

  for (;;) {
    const line = await reader.line();
    if (line === null) break;
    if (line === "") continue;
    if (line.startsWith("commit ")) await handleCommit(await parseCommit(reader, line.slice(7)));
    else if (line.startsWith("tag ")) await handleTag(await parseTag(reader, line.slice(4)));
    else if (line.startsWith("reset ")) {
      const ref = line.slice(6);
      const next = await reader.line();
      if (next?.startsWith("from ")) refTips.set(ref, resolve(next.slice(5)));
      else if (next !== null) reader.unread(next);
    } else if (/^(?:progress|feature|option|checkpoint|done)\b/.test(line)) continue;
    else throw new Error(`unexpected export command: ${line.slice(0, 60)}`);
  }

  for (const [ref, tip] of refTips) {
    if (keepRef(ref) && tip) await writer.write(`reset ${ref}\nfrom ${tip}\n\n`);
  }
  blobs.close();
  importer.stdin.end();
  await importDone;

  for (const ref of git(target, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)) {
    if (!keepRef(ref)) git(target, ["update-ref", "-d", ref]);
  }
  git(target, ["symbolic-ref", "HEAD", `refs/heads/${config.branch}`]);
  git(target, ["reset", "-q", "--hard"]);
  git(target, ["reflog", "expire", "--expire=now", "--all"]);
  git(target, ["gc", "-q", "--prune=now"]);
  return stats;
};

const listBlobs = (repo) => {
  const objects = git(repo, ["rev-list", "--objects", "--all"]);
  const checked = git(repo, ["cat-file", "--batch-check=%(objecttype) %(objectname) %(objectsize) %(rest)"], {
    input: objects,
  });
  const seen = new Map();
  for (const line of checked.split("\n")) {
    const [type, object, size, ...rest] = line.split(" ");
    if (type === "blob" && !seen.has(object)) seen.set(object, { object, size: Number(size), path: rest.join(" ") });
  }
  return [...seen.values()];
};

const introducingCommit = (repo, object) =>
  git(repo, ["log", "--all", "--reverse", "--format=%h", `--find-object=${object}`]).split("\n")[0] || "unknown";

export const scanRepo = async ({ repo, rules, literals, isPublic }) => {
  const findings = [];
  const detectors = isPublic ? [...literals, ...rules.blobRules].map((rule) => [rule.name, rule.detector]) : [];
  const allowed = rules.scanAllowedEmailDomains ?? [];
  const domainAllowed = (domain) =>
    allowed.some((entry) => domain.toLowerCase() === entry || domain.toLowerCase().endsWith(`.${entry}`));
  const check = (text) => {
    const hits = new Set();
    for (const [name, shape] of TOKEN_SHAPES)
      if (shape.test(text) && !/EXAMPLE/.test(text.match(shape)[0])) hits.add(name);
    for (const [name, detector] of detectors) {
      detector.lastIndex = 0;
      if (detector.test(text)) hits.add(name);
    }
    if (isPublic)
      for (const match of text.matchAll(EMAIL)) if (!domainAllowed(match[1])) hits.add("unlisted-email-domain");
    return hits;
  };
  const blobs = new BlobReader(repo);
  for (const blob of listBlobs(repo)) {
    const { content } = await blobs.read(blob.object);
    if (isBinary(content)) continue;
    for (const rule of check(content.toString("utf8"))) {
      findings.push({ scanner: "node", rule, path: blob.path, commit: introducingCommit(repo, blob.object) });
    }
  }
  blobs.close();
  const log = git(repo, ["log", "--all", "--format=%h%x00%B%x00"]).split("\0");
  for (let index = 0; index + 1 < log.length; index += 2) {
    for (const rule of check(log[index + 1])) {
      findings.push({ scanner: "node", rule, path: "(commit message)", commit: log[index].trim() });
    }
  }
  const trailerDetectors = rules.attributionRules.filter((rule) => rule.count !== false).map((rule) => rule.detector);
  const trailers = log
    .filter((_, index) => index % 2 === 1)
    .filter((message) =>
      trailerDetectors.some((detector) => {
        detector.lastIndex = 0;
        return detector.test(message);
      }),
    ).length;
  const gitleaks = gitleaksScan(repo);
  return { findings: [...findings, ...gitleaks.findings], gitleaks: gitleaks.status, trailers };
};

const gitleaksScan = (repo) => {
  const binary = ["gitleaks", join(homedir(), ".local/bin/gitleaks")].find((candidate) => {
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!binary) return { status: "gitleaks not installed; the Node scanner ran alone", findings: [] };
  const report = join(repo, ".git", "gitleaks.json");
  try {
    execFileSync(binary, ["git", "--no-banner", "--redact", "-l", "error", "-f", "json", "-r", report, repo], {
      stdio: "ignore",
    });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const results = JSON.parse(readFileSync(report, "utf8"));
  rmSync(report);
  return {
    status: `gitleaks ${execFileSync(binary, ["version"], { encoding: "utf8" }).trim()} scanned every commit`,
    findings: results.map((result) => ({
      scanner: "gitleaks",
      rule: result.RuleID,
      path: result.File,
      commit: result.Commit.slice(0, 7),
    })),
  };
};

export const histogram = (repo) => {
  const rows = git(repo, ["log", "--all", "--format=%at %ai|%ct %ci"]).split("\n").filter(Boolean);
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let working = 0;
  const offenders = [];
  for (const row of rows) {
    const stamps = row.split("|").map((part) => {
      const [time, , , zone] = part.split(" ");
      return { time: Number(time), zone };
    });
    const committer = stamps[1];
    const { weekday, hour } = localParts(committer.time, committer.zone);
    grid[weekday][hour] += 1;
    if (stamps.some((stamp) => inWorkingHours(stamp.time, stamp.zone))) {
      working += 1;
      offenders.push(row);
    }
  }
  const graph = git(repo, ["log", "--all", "--format=%H %ct %P"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  const times = new Map(graph.map(([commit, time]) => [commit, Number(time)]));
  const monotonic =
    new Set(times.values()).size === times.size &&
    graph.every(([commit, , ...parents]) =>
      parents.filter(Boolean).every((parent) => times.get(parent) < times.get(commit)),
    );
  return { grid, working, offenders, monotonic, total: rows.length };
};

const identities = (repo) => {
  const counts = new Map();
  for (const line of git(repo, ["log", "--all", "--format=author %an <%ae>%ncommitter %cn <%ce>"]).split("\n")) {
    if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
};

const largestFiles = (repo, count) => {
  const byPath = new Map();
  for (const blob of listBlobs(repo)) {
    if ((byPath.get(blob.path)?.size ?? -1) < blob.size) byPath.set(blob.path, blob);
  }
  return [...byPath.values()].sort((a, b) => b.size - a.size).slice(0, count);
};

const holders = (config, path) =>
  Object.keys(config.repos).filter((name) => {
    const classify = buildClassifier(config, name, []);
    return path.split(", ").some((part) => classify(part.endsWith("/") ? `${part}probe` : part) !== null);
  });

const renderReport = ({ config, results, sourceCommits, generatedAt }) => {
  const lines = [
    "# tumpel history split report",
    "",
    `Generated ${generatedAt} from ${config.source} (${config.branch}, ${sourceCommits} commits) with seed \`${config.seed}\`.`,
    "Nothing was pushed. Found values are never printed; each finding names its scanner, rule, path and commit.",
    "",
    "## Placement to confirm",
    "",
    "| path | held by | note |",
    "|---|---|---|",
    ...Object.entries(config.unsure ?? {}).map(
      ([path, note]) => `| \`${path}\` | ${holders(config, path).join(", ") || "none"} | ${note} |`,
    ),
    "",
  ];
  for (const { name, spec, stats, scan, hours, people, largest, head } of results) {
    lines.push(`## ${name} (${spec.public ? "public, scrubbed" : "private, not scrubbed"})`, "");
    lines.push(
      `- Commits: ${stats.before} in the source, ${stats.after} after the split, ${stats.empty} dropped as empty.`,
      `- Commits retimed: ${stats.retimed}. Commit dates strictly increase in topological order: ${hours.monotonic ? "yes" : "NO"}.`,
      `- Commits with an author or committer date in Mon-Fri 08:00-22:00 (own offset): **${hours.working}** of ${hours.total}.`,
      `- Files at HEAD: ${head}.`,
      `- Claude trailers: ${scan.trailers}.`,
      `- Path collisions: ${stats.collisions.length ? stats.collisions.join(", ") : "none"}.`,
      "",
      "### Committer time by weekday and hour (own offset)",
      "",
      `| | ${Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")).join(" | ")} | total |`,
      `|---|${Array(25).fill("---:").join("|")}|`,
    );
    for (const weekday of [1, 2, 3, 4, 5, 6, 0]) {
      const row = hours.grid[weekday];
      lines.push(
        `| ${WEEKDAYS[weekday]} | ${row.map((count) => (count ? String(count) : ".")).join(" | ")} | ${row.reduce((a, b) => a + b, 0)} |`,
      );
    }
    lines.push("", "### Scan", "", `${scan.gitleaks}; the Node scanner checked every blob and commit message.`, "");
    if (scan.findings.length === 0) lines.push("Findings: **0**.", "");
    else {
      lines.push(
        `Findings: **${scan.findings.length}**.`,
        "",
        "| scanner | rule | path | commit |",
        "|---|---|---|---|",
      );
      for (const finding of scan.findings) {
        lines.push(`| ${finding.scanner} | ${finding.rule} | ${finding.path} | ${finding.commit} |`);
      }
      lines.push("");
    }
    lines.push("### Identities", "", "| role and identity | commits |", "|---|---:|");
    for (const [identity, count] of people) lines.push(`| ${identity} | ${count} |`);
    lines.push("", "### Largest files in history", "", "| bytes | path |", "|---:|---|");
    for (const file of largest) lines.push(`| ${file.size} | ${file.path} |`);
    lines.push("");
  }
  return lines.join("\n");
};

export const loadRules = (path) => {
  const rawRules = JSON.parse(readFileSync(path, "utf8"));
  return {
    ...rawRules,
    blobRules: rawRules.blobRules.map(compileRule),
    messageRules: rawRules.messageRules.map(compileRule),
    attributionRules: (rawRules.attributionRules ?? []).map(compileRule),
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(args.config, "utf8"));
  const rules = loadRules(args.rules);
  const literals = loadLiterals(config.literalsFile);
  const output = expand(args.output ?? config.output);
  const work = join(output, ".work");
  const source = join(work, "source.git");
  mkdirSync(work, { recursive: true });
  rmSync(source, { recursive: true, force: true });
  git(work, [
    "clone",
    "-q",
    "--bare",
    "--single-branch",
    "--branch",
    config.branch,
    expand(args.source ?? config.source),
    source,
  ]);
  const sourceCommits = Number(git(source, ["rev-list", "--count", "--all"]).trim());
  const names = args.only.length ? args.only : Object.keys(config.repos);
  const results = [];
  for (const name of names) {
    const spec = config.repos[name];
    if (!spec) throw new Error(`no repo named ${name} in ${args.config}`);
    const target = join(output, name);
    console.log(`${name}: splitting`);
    const stats = await splitRepo({ config, name, source, target, rules, literals });
    console.log(`${name}: ${stats.after} of ${stats.before} commits kept; scanning`);
    const scan = await scanRepo({ repo: target, rules, literals, isPublic: spec.public });
    const hours = histogram(target);
    results.push({
      name,
      spec,
      stats,
      scan,
      hours,
      people: identities(target),
      largest: largestFiles(target, 10),
      head: git(target, ["ls-files"]).split("\n").filter(Boolean).length,
    });
    console.log(
      `${name}: ${scan.findings.length} scan findings, ${scan.trailers} Claude trailers, ${hours.working} commits in working hours, monotonic ${hours.monotonic}`,
    );
  }
  rmSync(source, { recursive: true, force: true });
  const report = join(output, "REPORT.md");
  writeFileSync(report, renderReport({ config, results, sourceCommits, generatedAt: new Date().toISOString() }));
  console.log(`report: ${report}`);
  if (results.some((result) => result.spec.public && result.scan.findings.length > 0)) process.exitCode = 1;
  if (results.some((result) => result.hours.working > 0 || !result.hours.monotonic || result.scan.trailers > 0)) {
    process.exitCode = 1;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
