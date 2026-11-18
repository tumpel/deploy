#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  checkDevcontainer,
  DEVCONTAINER_PATHS,
  describeFinding,
  readDevcontainer,
  resolveContainerEnv,
  SETUP_COMMANDS,
} from "../packages/control-plane/src/devcontainer.ts";

const USAGE = `usage:
  prebuild.mjs build <out dir>
    Runs in the guest image with the repository checked out at /root/workspace, a directory and
    not a symlink. Reads .devcontainer/devcontainer.json or .devcontainer.json; with neither, runs
    the default config: npm ci as onCreateCommand when package-lock.json or npm-shrinkwrap.json is
    at the workspace root, and nothing otherwise, since npm is the one package manager the guest
    image carries. Scans the image's files just before the commands run, then runs onCreateCommand, updateContentCommand and
    postCreateCommand in the workspace with exactly the environment /etc/tumpel/guest.json names
    plus containerEnv (remoteEnv is ignored). Replaces .git/config with core settings and an origin
    URL without user info before the commands run, then writes <out dir>/layer.tar, one
    uncompressed OCI layer of the workspace, the changed image paths and whiteouts for the removed
    ones, and <out dir>/layer.json with its sha256 and size. A layer over 5 GiB fails LayerTooLarge.
    TUMPEL_PREBUILD_SECONDS bounds the commands, 3600 by default. The environment is clean only
    when the S7 workflow runs the build in docker run with no runner environment and no runner
    mounts but the workspace: a command can read the runner's environment from /proc/$PPID/environ.
  prebuild.mjs run
    Runs in a tumpel box with the repository cloned at /root/workspace: reads the config and runs
    its lifecycle commands as build does, with the PATH, HOME and LANG tumpel-guest starts it with
    in place of guest.json, since a box booted from the base image and a harness layer has none.
    Writes no layer, since the box's snapshot holds the result. Leaves .git/config as the clone
    wrote it.
  prebuild.mjs start
    Runs in a tumpel box restored from a prebuild, right after tumpel-guest pulls the branch at the
    session's first turn: runs postStartCommand the way run runs the lifecycle commands, so the
    repository can bring what the prebuild generated up to the pulled commit.
  prebuild.mjs upload <out dir> <api origin> <tenant id> <prebuild id>
    Runs in a job that runs no repository code. Takes the job's OIDC token from TUMPEL_JOB_TOKEN
    when set, as the CircleCI orb mints it with aud <api origin>; otherwise, in a GitHub Actions step
    with id-token: write, requests the job's OIDC token with aud <api origin>. Exchanges it at
    POST /v1/prebuilds/<prebuild id>/uploads for one presigned PUT of the layer, PUTs layer.tar
    before the grant expires, then calls POST /v1/prebuilds/<prebuild id>/uploads/complete.`;

const PRUNED = ["run", "tmp", "var/tmp", "mnt", "rom", "overlay", "etc/hosts", "etc/hostname", "etc/resolv.conf"];
const WORKSPACE = "root/workspace";
const GUEST_CONFIG = "etc/tumpel/guest.json";
const MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar";
const MAX_LAYER_BYTES = 5 * 2 ** 30;
const BUILD_SECONDS = Number(process.env.TUMPEL_PREBUILD_SECONDS ?? 3600);

const die = (message) => {
  console.error(`prebuild: ${message}`);
  process.exit(1);
};

const DEFAULT_INSTALLS = [
  ["package-lock.json", "npm ci"],
  ["npm-shrinkwrap.json", "npm ci"],
];

const defaultConfig = (workspace) => {
  const found = DEFAULT_INSTALLS.find(([file]) => existsSync(join(workspace, file)));
  return found === undefined ? {} : { onCreateCommand: found[1] };
};

const DEFAULT_SOURCE = "the default config, as no devcontainer.json exists";

const fixOf = (devcontainer, name) =>
  devcontainer.kind === "RepositoryFile"
    ? `fix ${name} in ${devcontainer.path}`
    : "fix what it names in package.json or the npm lockfile, or commit a .devcontainer/devcontainer.json whose onCreateCommand installs the dependencies";

const checked = (devcontainer) => {
  if (devcontainer.findings.length > 0) die(devcontainer.findings.map(describeFinding).join("\nprebuild: "));
  return devcontainer;
};

const loadDevcontainer = (workspace) => {
  const path = DEVCONTAINER_PATHS.map((candidate) => join(workspace, candidate)).find((candidate) =>
    existsSync(candidate),
  );
  if (!path) {
    const config = defaultConfig(workspace);
    console.log(
      `prebuild: ${workspace} holds no devcontainer.json, so the prebuild runs the default: ${JSON.stringify(config)}`,
    );
    return { kind: "Default", ...checked(checkDevcontainer(config, DEFAULT_SOURCE)) };
  }
  return { kind: "RepositoryFile", path, ...checked(readDevcontainer(readFileSync(path, "utf8"), path)) };
};

const imageEnvironment = (root) => {
  const path = join(root, GUEST_CONFIG);
  if (!existsSync(path))
    die(`NotAGuestImage: ${path} is missing; run the prebuild in a tumpel guest image built by npm run guest:image`);
  return JSON.parse(readFileSync(path, "utf8")).environment;
};

const GUEST_VARIABLES = ["PATH", "HOME", "LANG"];

const guestEnvironment = (env) => {
  const missing = GUEST_VARIABLES.filter((name) => !env[name]);
  if (missing.length > 0)
    die(
      `NotAGuestBox: ${missing.join(", ")} is not set; prebuild.mjs run takes the harness environment from tumpel-guest, so start it through a prebuild turn`,
    );
  return Object.fromEntries(GUEST_VARIABLES.map((name) => [name, env[name]]));
};

const killGroup = (pid) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

const runCommand = (command, cwd, env, deadline) =>
  new Promise((resolveRun) => {
    console.log(`prebuild: running ${command.label}`);
    const child = spawn(command.file, command.args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => killGroup(child.pid), Math.max(deadline - Date.now(), 0));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun(`${command.label} could not start (${error.message})`);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      killGroup(child.pid);
      if (code === 0) resolveRun(undefined);
      else if (Date.now() >= deadline)
        resolveRun(`${command.label} ran past the ${BUILD_SECONDS} s build budget (TUMPEL_PREBUILD_SECONDS)`);
      else resolveRun(`${command.label} exited with ${code ?? signal}`);
    });
  });

const runLifecycle = async (workspace, env, devcontainer, names = SETUP_COMMANDS, prefix = "BuildFailed") => {
  const deadline = Date.now() + BUILD_SECONDS * 1000;
  for (const name of names) {
    const failures = (
      await Promise.all(
        devcontainer.commands
          .filter((command) => command.lifecycle === name)
          .map((command) => runCommand(command, workspace, env, deadline)),
      )
    ).filter(Boolean);
    if (failures.length > 0) die(`${prefix}: ${failures.join("; ")}; ${fixOf(devcontainer, name)}`);
  }
};

const gitConfig = (file, args) => spawnSync("git", ["config", "--file", file, ...args], { encoding: "utf8" });

const withoutUserInfo = (url) => {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
};

const resetGitConfig = (workspace) => {
  const file = join(workspace, ".git", "config");
  const read = (args) => {
    const result = gitConfig(file, args);
    if (result.error) die(`git could not run (${result.error.message}); run the prebuild in a tumpel guest image`);
    return result.status === 0 ? result.stdout.trim() : "";
  };
  const formatVersion = read(["--get", "core.repositoryformatversion"]) || "0";
  const extensions = read(["--get-regexp", "^extensions\\."])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  const origin = read(["--get", "remote.origin.url"]);
  const lines = [
    "[core]",
    `\trepositoryformatversion = ${formatVersion}`,
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
  ];
  if (extensions.length > 0)
    lines.push("[extensions]", ...extensions.map(([key, value]) => `\t${key.slice("extensions.".length)} = ${value}`));
  if (origin)
    lines.push(
      '[remote "origin"]',
      `\turl = ${withoutUserInfo(origin)}`,
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    );
  writeFileSync(file, `${lines.join("\n")}\n`);
};

const fingerprint = (path) => {
  const stat = lstatSync(path, { bigint: true });
  const link = stat.isSymbolicLink() ? readlinkSync(path) : "";
  return {
    stat,
    key: [stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, link].join(":"),
  };
};

const walk = (root, skip) => {
  const entries = new Map();
  const rootDev = lstatSync(root, { bigint: true }).dev;
  const visit = (relativePath) => {
    for (const name of readdirSync(join(root, relativePath))) {
      const child = relativePath ? `${relativePath}/${name}` : name;
      if (skip(child)) continue;
      const { stat, key } = fingerprint(join(root, child));
      if (stat.isDirectory() && stat.dev !== rootDev) continue;
      entries.set(child, { key, directory: stat.isDirectory() });
      if (stat.isDirectory()) visit(child);
    }
  };
  visit("");
  return entries;
};

const tar = (args) => {
  const result = spawnSync("tar", args, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) die(`tar could not run (${result.error.message}); install GNU tar in the base image`);
  if (result.status !== 0) die(`tar ${args.join(" ")} exited with ${result.status ?? result.signal}`);
};

const sha256 = (path) =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", reject);
  });

const checkout = (workspace) => {
  const stat = existsSync(workspace) ? lstatSync(workspace) : undefined;
  if (stat === undefined || !stat.isDirectory() || !existsSync(join(workspace, ".git", "config")))
    die(
      `NoCheckout: ${workspace} is not a directory holding a git checkout; check the repository out there, not through a symlink, before the prebuild`,
    );
};

const build = async (outDir) => {
  const root = resolve(process.env.TUMPEL_PREBUILD_ROOT ?? "/");
  const workspace = join(root, WORKSPACE);
  const out = resolve(outDir);
  checkout(workspace);
  const outRelative = relative(root, out);
  const pruned = new Set(PRUNED);
  const skip = (path) => pruned.has(path) || path === outRelative || path === WORKSPACE;
  const devcontainer = loadDevcontainer(workspace);
  const env = resolveContainerEnv(imageEnvironment(root), devcontainer.containerEnv);
  resetGitConfig(workspace);
  const before = walk(root, skip);
  await runLifecycle(workspace, env, devcontainer);
  const after = walk(root, skip);
  const changed = [...after].filter(([path, entry]) => before.get(path)?.key !== entry.key).map(([path]) => path);
  const removed = [...before.keys()].filter((path) => {
    const parent = dirname(path);
    return !after.has(path) && (parent === "." || after.get(parent)?.directory === true);
  });
  const workspaceEntries = [
    WORKSPACE,
    ...[...walk(workspace, () => false).keys()].map((path) => `${WORKSPACE}/${path}`),
  ];
  mkdirSync(out, { recursive: true });
  const layer = join(out, "layer.tar");
  const scratch = mkdtempSync(join(out, ".layer-"));
  const contentList = join(scratch, "content");
  writeFileSync(contentList, `${[...changed, ...workspaceEntries].sort().join("\0")}\0`);
  const common = ["--format=posix", "--pax-option=delete=atime,delete=ctime", "--numeric-owner", "--no-recursion"];
  tar(["-C", root, ...common, "--null", "-T", contentList, "-cf", layer]);
  if (removed.length > 0) {
    const whiteouts = removed.sort().map((path) => join(dirname(path), `.wh.${basename(path)}`));
    const tree = join(scratch, "whiteouts");
    for (const path of whiteouts) {
      mkdirSync(dirname(join(tree, path)), { recursive: true });
      writeFileSync(join(tree, path), "", { mode: 0o644 });
    }
    const whiteoutList = join(scratch, "whiteouts.list");
    writeFileSync(whiteoutList, `${whiteouts.join("\0")}\0`);
    tar(["-C", tree, ...common, "--owner=0", "--group=0", "--null", "-T", whiteoutList, "-rf", layer]);
  }
  rmSync(scratch, { recursive: true, force: true });
  const sizeBytes = statSync(layer).size;
  if (sizeBytes > MAX_LAYER_BYTES)
    die(
      `LayerTooLarge: ${layer} is ${sizeBytes} bytes, over the 5 GiB a single presigned PUT takes; keep caches and build output out of the image, or delete them at the end of postCreateCommand`,
    );
  const description = { mediaType: MEDIA_TYPE, sha256: await sha256(layer), sizeBytes };
  writeFileSync(join(out, "layer.json"), `${JSON.stringify(description, null, 2)}\n`);
  console.log(
    `prebuild: ${layer} holds ${changed.length} changed paths, ${workspaceEntries.length} workspace paths and ${removed.length} whiteouts, sha256 ${description.sha256}`,
  );
};

const required = (name) => {
  const value = process.env[name];
  if (!value)
    die(`TokenUnavailable: ${name} is not set; give the job id-token: write and run the upload as a step of that job`);
  return value;
};

const jobToken = async (audience) => {
  if (process.env.TUMPEL_JOB_TOKEN) return process.env.TUMPEL_JOB_TOKEN;
  const url = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: { authorization: `bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}` },
  });
  if (!response.ok)
    die(`TokenUnavailable: the GitHub Actions token request answered ${response.status}; give the job id-token: write`);
  const { value } = await response.json();
  if (typeof value !== "string" || value.length === 0)
    die("TokenUnavailable: the GitHub Actions token response holds no value; give the job id-token: write");
  return value;
};

const exchange = async (url, token, body, failure) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) die(`${failure}: POST ${url} answered ${response.status}: ${text}`);
  return JSON.parse(text);
};

const put = (url, headers, path, deadline) =>
  new Promise((resolvePut, reject) => {
    const seconds = Math.floor((deadline - Date.now()) / 1000);
    if (seconds <= 0) die("UploadFailed: the upload grant expired before the PUT started; run the upload again");
    const send = url.startsWith("https:") ? httpsRequest : httpRequest;
    const req = send(url, { method: "PUT", headers, timeout: seconds * 1000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePut({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
      response.on("error", reject);
    });
    req.on("timeout", () =>
      req.destroy(new Error(`UploadFailed: the PUT ran past the grant's expiry ${new Date(deadline).toISOString()}`)),
    );
    req.on("error", reject);
    createReadStream(path).pipe(req);
  });

const upload = async (outDir, apiOrigin, tenantId, prebuildId) => {
  const origin = URL.canParse(apiOrigin)
    ? new URL(apiOrigin).origin
    : die(`${apiOrigin} is not an API origin; pass one like https://api.tumpel.dev`);
  const description = JSON.parse(readFileSync(join(outDir, "layer.json"), "utf8"));
  const uploads = `${origin}/v1/prebuilds/${encodeURIComponent(prebuildId)}/uploads`;
  const grant = await exchange(
    uploads,
    await jobToken(origin),
    { tenantId, layerDigest: description.sha256, layerSizeBytes: description.sizeBytes },
    "ExchangeRefused",
  );
  const deadline = Date.parse(grant.uploadExpiresAt);
  if (typeof grant.url !== "string" || Number.isNaN(deadline))
    die(`ExchangeRefused: POST ${uploads} answered no url and uploadExpiresAt; check the API origin`);
  if (grant.sha256 !== description.sha256)
    die(
      `ExchangeRefused: the grant is signed for ${grant.sha256}, the layer is ${description.sha256}; run the upload again`,
    );
  const { status, text } = await put(
    grant.url,
    {
      "content-type": MEDIA_TYPE,
      "content-length": String(description.sizeBytes),
      "x-amz-checksum-sha256": Buffer.from(description.sha256, "hex").toString("base64"),
    },
    join(outDir, "layer.tar"),
    deadline,
  );
  if (status !== 200) die(`UploadFailed: the PUT answered ${status}: ${text}; run the upload again`);
  await exchange(`${uploads}/complete`, await jobToken(origin), { tenantId }, "CompleteRefused");
  console.log(`prebuild: uploaded ${description.sizeBytes} bytes, sha256 ${description.sha256}, to ${prebuildId}`);
};

const run = async () => {
  const root = resolve(process.env.TUMPEL_PREBUILD_ROOT ?? "/");
  const workspace = join(root, WORKSPACE);
  checkout(workspace);
  console.log(`prebuild: running the setup step of ${workspace}`);
  const devcontainer = loadDevcontainer(workspace);
  await runLifecycle(
    workspace,
    resolveContainerEnv(guestEnvironment(process.env), devcontainer.containerEnv),
    devcontainer,
  );
};

const start = async () => {
  const workspace = join(resolve(process.env.TUMPEL_PREBUILD_ROOT ?? "/"), WORKSPACE);
  checkout(workspace);
  const devcontainer = loadDevcontainer(workspace);
  await runLifecycle(
    workspace,
    resolveContainerEnv(guestEnvironment(process.env), devcontainer.containerEnv),
    devcontainer,
    ["postStartCommand"],
    "PostStartFailed",
  );
};

const [command, ...args] = process.argv.slice(2);
if (command === "build" && args.length === 1) await build(args[0]);
else if (command === "run" && args.length === 0) await run();
else if (command === "start" && args.length === 0) await start();
else if (command === "upload" && args.length === 4) await upload(...args);
else die(USAGE);
