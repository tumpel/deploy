#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { UBUNTU_PACKAGES } from "./guest-packages.mjs";

const ROOTS = ["build-essential", "pkg-config", "jq", "unzip", "zip", "ripgrep", "fd-find", "tree"];
const POCKETS = new Set(["Release", "Updates", "Security"]);
const STATUSES = new Set(["Published", "Superseded"]);
const ARCHIVES = { amd64: "http://archive.ubuntu.com/ubuntu", arm64: "http://ports.ubuntu.com/ubuntu-ports" };
const LAUNCHPAD_FILES = "https://launchpad.net/ubuntu/+archive/primary/+files";
const LAUNCHPAD_API = "https://api.launchpad.net/1.0";
const UNTRACKED = /^\/usr\/share\/(doc|man|info|lintian|locale)\//;
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), "guest-packages.mjs");
const CACHE = join(process.env.TUMPEL_IMAGE_DIR ?? join(homedir(), "development", ".tmp", "tumpel-images"), "packages");

const die = (message) => {
  console.error(`guest:packages: ${message}`);
  process.exit(1);
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { maxBuffer: 2 ** 30, ...options });
  if (result.status !== 0)
    die(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}: ${result.stderr?.toString()}`);
  return result.stdout;
};

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const order = (char) => {
  if (char === "~") return -1;
  if (char === undefined) return 0;
  if (/[A-Za-z]/.test(char)) return char.charCodeAt(0);
  return char.charCodeAt(0) + 256;
};

const comparePart = (left, right) => {
  let [a, b] = [left, right];
  while (a.length > 0 || b.length > 0) {
    const [textA] = a.match(/^[^0-9]*/);
    const [textB] = b.match(/^[^0-9]*/);
    for (let index = 0; index < Math.max(textA.length, textB.length); index++) {
      const difference = order(textA[index]) - order(textB[index]);
      if (difference !== 0) return difference;
    }
    a = a.slice(textA.length);
    b = b.slice(textB.length);
    const [digitsA] = a.match(/^[0-9]*/);
    const [digitsB] = b.match(/^[0-9]*/);
    const difference = Number(digitsA || 0) - Number(digitsB || 0);
    if (difference !== 0) return difference;
    a = a.slice(digitsA.length);
    b = b.slice(digitsB.length);
  }
  return 0;
};

const split = (version) => {
  const epoch = version.match(/^(\d+):/);
  const rest = epoch ? version.slice(epoch[0].length) : version;
  const dash = rest.lastIndexOf("-");
  return [Number(epoch?.[1] ?? 0), dash < 0 ? rest : rest.slice(0, dash), dash < 0 ? "0" : rest.slice(dash + 1)];
};

const compare = (left, right) => {
  const [a, b] = [split(left), split(right)];
  return a[0] - b[0] || comparePart(a[1], b[1]) || comparePart(a[2], b[2]);
};

const newer = (left, right) => compare(left, right) > 0;

const satisfies = (version, constraint) => {
  if (!constraint) return true;
  const difference = compare(version, constraint.version);
  return {
    "<<": difference < 0,
    "<=": difference <= 0,
    "<": difference <= 0,
    "=": difference === 0,
    ">=": difference >= 0,
    ">": difference >= 0,
    ">>": difference > 0,
  }[constraint.op];
};

const fetchOk = async (url) => {
  const response = await fetch(url);
  if (!response.ok) die(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const parseStanzas = (text) =>
  text
    .split("\n\n")
    .filter((stanza) => stanza.trim())
    .map((stanza) => {
      const fields = {};
      let last;
      for (const line of stanza.split("\n")) {
        if (/^\s/.test(line) && last) fields[last] += `\n${line}`;
        else {
          const at = line.indexOf(":");
          last = line.slice(0, at);
          fields[last] = line.slice(at + 1).trim();
        }
      }
      return fields;
    });

const parseRelations = (field) =>
  (field ?? "")
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) =>
      group.split("|").map((alternative) => {
        const match = alternative.trim().match(/^([^\s:(]+)(?::\S+)?\s*(?:\((<<|<=|=|>=|>>|<|>)\s*([^)]+)\))?/);
        return {
          name: match[1],
          constraint: match[2] ? { op: match[2], version: match[3].trim() } : undefined,
        };
      }),
    );

const catalog = async (arch) => {
  const packages = new Map();
  const providers = new Map();
  for (const suite of ["noble", "noble-updates", "noble-security"])
    for (const component of ["main", "universe"]) {
      const url = `${ARCHIVES[arch]}/dists/${suite}/${component}/binary-${arch}/Packages.gz`;
      for (const stanza of parseStanzas(gunzipSync(await fetchOk(url)).toString())) {
        for (const [{ name }] of parseRelations(stanza.Provides))
          providers.set(name, [...new Set([...(providers.get(name) ?? []), stanza.Package])]);
        const known = packages.get(stanza.Package);
        if (!known || newer(stanza.Version, known.Version)) packages.set(stanza.Package, stanza);
      }
    }
  return { packages, providers };
};

const snapshotStamp = (milliseconds) => new Date(milliseconds).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

const versionsOf = async (name, arch) => {
  const versions = new Map();
  let url = `${LAUNCHPAD_API}/ubuntu/+archive/primary?ws.op=getPublishedBinaries&binary_name=${encodeURIComponent(name)}&exact_match=true&distro_arch_series=${LAUNCHPAD_API}/ubuntu/noble/${arch}&ws.size=300`;
  while (url) {
    const page = JSON.parse((await fetchOk(url)).toString());
    for (const entry of page.entries)
      if (POCKETS.has(entry.pocket) && STATUSES.has(entry.status)) {
        const known = versions.get(entry.binary_package_version);
        const published = Date.parse(entry.date_published);
        const superseded = entry.date_superseded ? Date.parse(entry.date_superseded) : Date.now();
        versions.set(entry.binary_package_version, {
          debArch: entry.architecture_specific ? arch : "all",
          component: entry.component_name,
          source: entry.source_package_name,
          published: Math.min(published, known?.published ?? published),
          superseded: Math.min(superseded, known?.superseded ?? superseded),
        });
      }
    url = page.next_collection_link;
  }
  return [...versions]
    .map(([version, { debArch, component, source, published, superseded }]) => ({
      name,
      version,
      component,
      source,
      snapshot: snapshotStamp((published + superseded) / 2),
      file: `${name}_${version.replace(/^\d+:/, "")}_${debArch}.deb`,
    }))
    .sort((left, right) => (newer(left.version, right.version) ? -1 : 1));
};

const debCache = new Map();

const deb = async (file) => {
  if (debCache.has(file)) return debCache.get(file);
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, file);
  if (!existsSync(path)) {
    writeFileSync(`${path}.part`, await fetchOk(`${LAUNCHPAD_FILES}/${encodeURIComponent(file)}`));
    renameSync(`${path}.part`, path);
  }
  const tar = run("dpkg-deb", ["--fsys-tarfile", path]);
  const entries = run("tar", ["-tv"], { input: tar })
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ kind: line[0], path: line.split(/\s+/)[5].replace(/^\./, "") }))
    .filter((entry) => entry.kind !== "d");
  const control = parseStanzas(run("dpkg-deb", ["-f", path]).toString())[0];
  const parsed = { path, tar, entries, control, digest: sha256(readFileSync(path)) };
  debCache.set(file, parsed);
  return parsed;
};

const fileInDeb = (parsed, path) => run("tar", ["-xO", `.${path}`], { input: parsed.tar });

const resolve = async (arch, squashfs) => {
  const baseFiles = new Set(
    run("unsquashfs", ["-l", squashfs])
      .toString()
      .split("\n")
      .map((line) => line.replace(/^squashfs-root/, "")),
  );
  const baseFile = (path) => run("unsquashfs", ["-cat", squashfs, path.slice(1)]);
  const { packages, providers } = await catalog(arch);
  const history = new Map();
  const versions = async (name) => {
    if (!history.has(name)) history.set(name, await versionsOf(name, arch));
    return history.get(name);
  };
  const tracked = (parsed) => parsed.entries.filter((entry) => !UNTRACKED.test(entry.path));
  const inBaseCache = new Map();
  const inBase = async (name) => {
    if (inBaseCache.has(name)) return inBaseCache.get(name);
    const [latest] = await versions(name);
    const files = latest === undefined ? [] : tracked(await deb(latest.file));
    const found = files.length > 0 && files.every((entry) => baseFiles.has(entry.path));
    inBaseCache.set(name, found);
    return found;
  };
  const baseVersionCache = new Map();
  const baseVersion = async (name) => {
    if (baseVersionCache.has(name)) return baseVersionCache.get(name);
    for (const candidate of await versions(name)) {
      const parsed = await deb(candidate.file);
      const probes = tracked(parsed)
        .filter((entry) => entry.kind === "-" && entry.path.startsWith("/usr/"))
        .slice(0, 3);
      if (probes.length === 0) continue;
      if (probes.every((entry) => sha256(fileInDeb(parsed, entry.path)) === sha256(baseFile(entry.path)))) {
        baseVersionCache.set(name, candidate.version);
        return candidate.version;
      }
    }
    return die(`no published version of ${name} matches the files of the base rootfs ${squashfs}`);
  };
  const realName = async (name) => {
    if (packages.has(name)) return { name, real: true };
    const offered = providers.get(name) ?? [];
    for (const provider of offered) if (await inBase(provider)) return { name: provider, real: false, base: true };
    if (offered.length === 0) return die(`no package is or provides ${name} for ${arch}`);
    return { name: offered[0], real: false };
  };

  const chosen = new Map();
  const wanted = new Map();
  const queue = ROOTS.map((name) => ({ name, constraint: undefined, by: "the root list" }));
  const baseHolds = async (relation) => {
    if (!(await inBase(relation.name))) return false;
    if (relation.constraint && !satisfies(await baseVersion(relation.name), relation.constraint))
      return die(
        `the base rootfs carries ${relation.name} ${await baseVersion(relation.name)}, which does not satisfy ${relation.constraint.op} ${relation.constraint.version}`,
      );
    return true;
  };
  const baseAllows = async (control) => {
    for (const group of parseRelations([control.Depends, control["Pre-Depends"]].filter(Boolean).join(", "))) {
      for (const relation of group) {
        if (!relation.constraint || !packages.has(relation.name) || !(await inBase(relation.name))) continue;
        if (!satisfies(await baseVersion(relation.name), relation.constraint)) return false;
      }
    }
    return true;
  };
  while (queue.length > 0) {
    const { name, constraint, by } = queue.shift();
    if (constraint) wanted.set(name, [...(wanted.get(name) ?? []), { constraint, by }]);
    if (chosen.has(name)) {
      const version = chosen.get(name).version;
      if (constraint && !satisfies(version, constraint))
        die(`${by} needs ${name} ${constraint.op} ${constraint.version}, the resolver already chose ${version}`);
      continue;
    }
    if (await inBase(name)) continue;
    let picked;
    for (const candidate of await versions(name)) {
      if (!(wanted.get(name) ?? []).every((want) => satisfies(candidate.version, want.constraint))) continue;
      const parsed = await deb(candidate.file);
      if (!(await baseAllows(parsed.control))) continue;
      picked = { ...candidate, ...parsed };
      break;
    }
    if (!picked) die(`no published version of ${name} fits the base rootfs and ${by}`);
    chosen.set(name, picked);
    for (const group of parseRelations(
      [picked.control["Pre-Depends"], picked.control.Depends].filter(Boolean).join(", "),
    )) {
      let held = false;
      for (const relation of group) {
        held = chosen.has(relation.name)
          ? satisfies(chosen.get(relation.name).version, relation.constraint)
          : await baseHolds(relation);
        if (held) break;
      }
      if (held) continue;
      const first = await realName(group[0].name);
      if (first.base) continue;
      queue.push({ name: first.name, constraint: first.real ? group[0].constraint : undefined, by: picked.file });
    }
  }
  for (const picked of chosen.values()) {
    const overwritten = tracked(picked).filter((entry) => baseFiles.has(entry.path));
    if (overwritten.length > 0)
      die(`${picked.file} overwrites ${overwritten.map((entry) => entry.path).join(", ")} of the base rootfs`);
  }
  return [...chosen.values()].sort((left, right) => left.name.localeCompare(right.name));
};

const main = async () => {
  const [arch, squashfs] = process.argv.slice(2);
  if (!ARCHIVES[arch] || !squashfs)
    die(
      "pass an architecture and the base rootfs squashfs: npm run guest:packages -- <amd64|arm64> <TUMPEL_IMAGE_DIR>/downloads/<rootfs digest in guest-image.mjs>",
    );
  const resolved = await resolve(arch, squashfs);
  const packages = {
    ...UBUNTU_PACKAGES,
    [arch]: resolved.map((picked) => [picked.file, picked.digest, picked.component, picked.source, picked.snapshot]),
  };
  writeFileSync(OUTPUT, `export const UBUNTU_PACKAGES = ${JSON.stringify(packages, null, 2)};\n`);
  for (const picked of resolved) console.log(picked.file);
};

await main();
