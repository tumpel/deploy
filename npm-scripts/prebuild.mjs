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

const USAGE = `usage:
  prebuild.mjs build <out dir>
    Runs in the guest image with the repository checked out at /root/workspace, a directory and
    not a symlink. Reads .devcontainer/devcontainer.json or .devcontainer.json, scans the image's
    files just before the commands run, then runs onCreateCommand, updateContentCommand and
    postCreateCommand in the workspace with exactly the environment /etc/tumpel/guest.json names
    plus containerEnv (remoteEnv is ignored). Replaces .git/config with core settings and an origin
    URL without user info before the commands run, then writes <out dir>/layer.tar, one
    uncompressed OCI layer of the workspace, the changed image paths and whiteouts for the removed
    ones, and <out dir>/layer.json with its sha256 and size. A layer over 5 GiB fails LayerTooLarge.
    TUMPEL_PREBUILD_SECONDS bounds the commands, 3600 by default.
  prebuild.mjs upload <out dir> <api origin> <tenant id> <prebuild id>
    Runs in a GitHub Actions step with id-token: write that runs no repository code. Requests the
    job's OIDC token with aud <api origin>, exchanges it at POST /v1/prebuilds/<prebuild id>/uploads
    for one presigned PUT of the layer, PUTs layer.tar before the grant expires, then calls
    POST /v1/prebuilds/<prebuild id>/uploads/complete.`;

const LIFECYCLE = ["onCreateCommand", "updateContentCommand", "postCreateCommand"];
const UNSUPPORTED = {
  image:
    "PrebuildImageUnsupported: devcontainer.json names an image; a prebuild builds on the tumpel guest image, so remove image (custom base images are a follow-up)",
  build:
    "PrebuildImageUnsupported: devcontainer.json names a build; a prebuild builds on the tumpel guest image, so remove build (Dockerfiles are a follow-up)",
  dockerFile:
    "PrebuildImageUnsupported: devcontainer.json names a dockerFile; a prebuild builds on the tumpel guest image, so remove dockerFile (Dockerfiles are a follow-up)",
  dockerComposeFile:
    "PrebuildImageUnsupported: devcontainer.json names a dockerComposeFile; a prebuild runs one container, so remove dockerComposeFile (Compose is a follow-up)",
  features:
    "PrebuildFeaturesUnsupported: devcontainer.json names features; install them from onCreateCommand instead (features are a follow-up)",
};
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

const outsideStrings = (text, step) => {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else {
      const [emitted, next] = step(text, index);
      out += emitted;
      index = next;
    }
  }
  return out;
};

const withoutComments = (text) =>
  outsideStrings(text, (source, index) => {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      return ["", end === -1 ? source.length : end];
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      return ["", end === -1 ? source.length : end + 2];
    }
    return [source[index], index + 1];
  });

const CLOSER_AHEAD = /\s*[}\]]/y;

const withoutTrailingCommas = (text) =>
  outsideStrings(text, (source, index) => {
    CLOSER_AHEAD.lastIndex = index + 1;
    return source[index] === "," && CLOSER_AHEAD.test(source) ? ["", index + 1] : [source[index], index + 1];
  });

const parseJsonc = (text) => JSON.parse(withoutTrailingCommas(withoutComments(text)));

const readDevcontainer = (workspace) => {
  const path = [join(workspace, ".devcontainer", "devcontainer.json"), join(workspace, ".devcontainer.json")].find(
    (candidate) => existsSync(candidate),
  );
  if (!path)
    die(
      `NoDevcontainer: ${workspace} holds neither .devcontainer/devcontainer.json nor .devcontainer.json; add one with an onCreateCommand`,
    );
  let config;
  try {
    config = parseJsonc(readFileSync(path, "utf8"));
  } catch (error) {
    die(`DevcontainerInvalid: ${path} is not JSON with comments (${error.message}); fix the file`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config))
    die(`DevcontainerInvalid: ${path} is not a JSON object; fix the file`);
  for (const [field, message] of Object.entries(UNSUPPORTED)) {
    const value = config[field];
    const empty = value === undefined || (field === "features" && Object.keys(value ?? {}).length === 0);
    if (!empty) die(`${message} (${path})`);
  }
  return { path, config };
};

const isStringMap = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

const imageEnvironment = (root) => {
  const path = join(root, GUEST_CONFIG);
  if (!existsSync(path))
    die(`NotAGuestImage: ${path} is missing; run the prebuild in a tumpel guest image built by npm run guest:image`);
  const environment = JSON.parse(readFileSync(path, "utf8")).environment;
  if (!isStringMap(environment) || !environment.PATH || !environment.HOME)
    die(
      `NotAGuestImage: ${path} names no environment with PATH and HOME; build the image again with npm run guest:image`,
    );
  return environment;
};

const CONTAINER_ENV_REFERENCE = /\$\{containerEnv:([^}:]+)(?::([^}]*))?\}/g;

const commandEnvironment = (image, { path, config }) => {
  if (config.containerEnv === undefined) return image;
  if (!isStringMap(config.containerEnv))
    die(`DevcontainerInvalid: containerEnv in ${path} is not an object of strings; fix the file`);
  const added = Object.fromEntries(
    Object.entries(config.containerEnv).map(([name, value]) => [
      name,
      value.replace(CONTAINER_ENV_REFERENCE, (_, referenced, fallback) => image[referenced] ?? fallback ?? ""),
    ]),
  );
  return { ...image, ...added };
};

const commandsOf = (name, value, path) => {
  if (value === undefined) return [];
  if (typeof value === "string") return [{ label: name, file: "/bin/sh", args: ["-c", value] }];
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string"))
    return [{ label: name, file: value[0], args: value.slice(1) }];
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return Object.entries(value).flatMap(([key, entry]) => {
      if (typeof entry === "object" && !Array.isArray(entry))
        die(`DevcontainerInvalid: ${name}.${key} in ${path} is neither a string nor an array; fix the file`);
      return commandsOf(`${name}.${key}`, entry, path);
    });
  return die(`DevcontainerInvalid: ${name} in ${path} is neither a string, an array nor an object; fix the file`);
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
      if (code === 0) resolveRun(undefined);
      else if (Date.now() >= deadline)
        resolveRun(`${command.label} ran past the ${BUILD_SECONDS} s build budget (TUMPEL_PREBUILD_SECONDS)`);
      else resolveRun(`${command.label} exited with ${code ?? signal}`);
    });
  });

const runLifecycle = async (workspace, env, { path, config }) => {
  const deadline = Date.now() + BUILD_SECONDS * 1000;
  for (const name of LIFECYCLE) {
    const failures = (
      await Promise.all(
        commandsOf(name, config[name], path).map((command) => runCommand(command, workspace, env, deadline)),
      )
    ).filter(Boolean);
    if (failures.length > 0) die(`BuildFailed: ${failures.join("; ")}; fix ${name} in ${path}`);
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
  const devcontainer = readDevcontainer(workspace);
  const env = commandEnvironment(imageEnvironment(root), devcontainer);
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

const [command, ...args] = process.argv.slice(2);
if (command === "build" && args.length === 1) await build(args[0]);
else if (command === "upload" && args.length === 4) await upload(...args);
else die(USAGE);
