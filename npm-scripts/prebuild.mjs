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
const PRUNED = [
  "proc",
  "sys",
  "dev",
  "run",
  "tmp",
  "var/tmp",
  "mnt",
  "rom",
  "overlay",
  "__e",
  "__t",
  "__w",
  "github",
  "etc/hosts",
  "etc/hostname",
  "etc/resolv.conf",
];
const WORKSPACE = "root/workspace";
const MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar";
const BUILD_SECONDS = Number(process.env.TUMPEL_PREBUILD_SECONDS ?? 3600);
const UPLOAD_SECONDS = 900;

const die = (message) => {
  console.error(`prebuild: ${message}`);
  process.exit(1);
};

const stripJsonc = (text) => {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
};

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
    config = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
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

const runCommand = (command, cwd, deadline) =>
  new Promise((resolveRun) => {
    console.log(`prebuild: running ${command.label}`);
    const child = spawn(command.file, command.args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(deadline - Date.now(), 0));
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

const runLifecycle = async (workspace, { path, config }) => {
  const deadline = Date.now() + BUILD_SECONDS * 1000;
  for (const name of LIFECYCLE) {
    const failures = (
      await Promise.all(commandsOf(name, config[name], path).map((command) => runCommand(command, workspace, deadline)))
    ).filter(Boolean);
    if (failures.length > 0) die(`BuildFailed: ${failures.join("; ")}; fix ${name} in ${path}`);
  }
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
      entries.set(child, key);
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

const build = async (outDir) => {
  const root = resolve(process.env.TUMPEL_PREBUILD_ROOT ?? "/");
  const workspace = join(root, WORKSPACE);
  const out = resolve(outDir);
  if (!existsSync(join(workspace, ".git")))
    die(`NoCheckout: ${workspace} holds no git checkout; check the repository out there before the prebuild`);
  const outRelative = relative(root, out);
  const pruned = new Set(PRUNED);
  const skip = (path) => pruned.has(path) || path === outRelative || path === WORKSPACE;
  const devcontainer = readDevcontainer(workspace);
  const before = walk(root, skip);
  await runLifecycle(workspace, devcontainer);
  const after = walk(root, skip);
  const changed = [...after].filter(([path, key]) => before.get(path) !== key).map(([path]) => path);
  const topRemoved = [...before.keys()].filter((path) => {
    const parent = dirname(path);
    return !after.has(path) && (parent === "." || after.has(parent));
  });
  const workspaceEntries = [WORKSPACE, ...walk(workspace, () => false).keys()].map((path) =>
    path === WORKSPACE ? path : `${WORKSPACE}/${path}`,
  );
  mkdirSync(out, { recursive: true });
  const layer = join(out, "layer.tar");
  const scratch = mkdtempSync(join(out, ".layer-"));
  const contentList = join(scratch, "content");
  writeFileSync(contentList, `${[...changed, ...workspaceEntries].sort().join("\0")}\0`);
  const common = ["--format=posix", "--pax-option=delete=atime,delete=ctime", "--numeric-owner", "--no-recursion"];
  tar(["-C", root, ...common, "--null", "-T", contentList, "-cf", layer]);
  if (topRemoved.length > 0) {
    const whiteouts = topRemoved.sort().map((path) => join(dirname(path), `.wh.${basename(path)}`));
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
  const description = {
    mediaType: MEDIA_TYPE,
    sha256: await sha256(layer),
    sizeBytes: statSync(layer).size,
  };
  writeFileSync(join(out, "layer.json"), `${JSON.stringify(description, null, 2)}\n`);
  console.log(
    `prebuild: ${layer} holds ${changed.length} changed paths, ${workspaceEntries.length} workspace paths and ${topRemoved.length} whiteouts, sha256 ${description.sha256}`,
  );
};

const readUpload = (source) => {
  const text = source ? readFileSync(source, "utf8") : process.env.TUMPEL_PREBUILD_UPLOAD;
  if (!text) die("pass the upload JSON as a file argument or in TUMPEL_PREBUILD_UPLOAD");
  const upload = JSON.parse(text);
  if (typeof upload?.url !== "string" || !/^https?:\/\//.test(upload.url))
    die("the upload JSON has no url; pass the PUT URL the upload exchange answered");
  if (typeof upload.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(upload.sha256))
    die("the upload JSON has no sha256; pass the layer digest the upload exchange signed");
  return upload;
};

const put = (url, headers, path) =>
  new Promise((resolvePut, reject) => {
    const send = url.startsWith("https:") ? httpsRequest : httpRequest;
    const req = send(url, { method: "PUT", headers, timeout: UPLOAD_SECONDS * 1000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePut({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`UploadFailed: the PUT took longer than ${UPLOAD_SECONDS} s`)));
    req.on("error", reject);
    createReadStream(path).pipe(req);
  });

const upload = async (outDir, source) => {
  const description = JSON.parse(readFileSync(join(outDir, "layer.json"), "utf8"));
  const target = readUpload(source);
  if (target.sha256 !== description.sha256)
    die(
      `UploadFailed: the upload URL is signed for ${target.sha256}, the layer is ${description.sha256}; exchange again with the layer digest`,
    );
  const checksum = Buffer.from(description.sha256, "hex").toString("base64");
  const { status, text } = await put(
    target.url,
    {
      "content-type": MEDIA_TYPE,
      "content-length": String(description.sizeBytes),
      "x-amz-checksum-sha256": checksum,
    },
    join(outDir, "layer.tar"),
  );
  if (status !== 200)
    die(`UploadFailed: the PUT answered ${status}: ${text}; exchange the layer digest for a fresh URL`);
  console.log(`prebuild: uploaded ${description.sizeBytes} bytes, sha256 ${description.sha256}`);
};

const [command, ...args] = process.argv.slice(2);
if (command === "build" && args.length === 1) await build(args[0]);
else if (command === "upload" && args.length >= 1 && args.length <= 2) await upload(args[0], args[1]);
else die("usage: prebuild.sh build <out dir> | upload <out dir> [upload.json]");
