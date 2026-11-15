#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { basename, dirname, join } from "node:path";
import { ChannelProtocol, GuestImageManifestSchema, ReleaseManifestSchema } from "@tumpel/api/schemas";
import { CHECKSUM_HEADER, checksumOf, presignUrl } from "../packages/control-plane/src/presign.ts";

const ARCHITECTURES = { amd64: "Amd64", arm64: "Arm64" };
const REQUEST_SECONDS = 900;
const SIGNED_SECONDS = 3600;

const FragmentSchema = ReleaseManifestSchema.pick({ images: true }).extend({
  supervisor: ReleaseManifestSchema.shape.supervisors.element,
  cli: ReleaseManifestSchema.shape.clis.element,
});

const die = (message) => {
  console.error(`release:publish: ${message}`);
  process.exit(1);
};

const required = (name) => {
  const value = process.env[name];
  if (!value) die(`${name} is not set; the release workflow passes it from the repository secret of the same name`);
  return value;
};

const stage = process.env.TUMPEL_STAGE || "dev";
const bucket = `tumpel-releases-${stage}`;

const storage = () => ({
  origin: `https://${required("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("R2_RELEASES_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_RELEASES_SECRET_ACCESS_KEY"),
    region: "auto",
    service: "s3",
  },
});

const sha256 = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

const send = (url, method, headers, body) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method, headers, timeout: REQUEST_SECONDS * 1000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
      response.on("error", reject);
    });
    req.on("timeout", () =>
      req.destroy(new Error(`${method} ${new URL(url).pathname} took longer than ${REQUEST_SECONDS} s`)),
    );
    req.on("error", reject);
    if (body === undefined) req.end();
    else if (typeof body === "string") req.end(body);
    else body.pipe(req);
  });

const segmentsOf = (key) => [bucket, ...key.split("/")];

const exists = async (store, key) => {
  const url = await presignUrl(store.credentials, "HEAD", store.origin, segmentsOf(key), SIGNED_SECONDS, new Date());
  const { status } = await send(url, "HEAD", {});
  if (status === 200) return true;
  if (status === 404) return false;
  return die(`HEAD ${bucket}/${key} answered ${status}; check that the R2 token can read ${bucket}`);
};

const put = async (store, key, digest, headers, body, size) => {
  const url = await presignUrl(store.credentials, "PUT", store.origin, segmentsOf(key), SIGNED_SECONDS, new Date(), [
    [CHECKSUM_HEADER, checksumOf(digest)],
  ]);
  const { status, text } = await send(
    url,
    "PUT",
    { ...headers, [CHECKSUM_HEADER]: checksumOf(digest), "content-length": String(size) },
    body,
  );
  if (status !== 200)
    die(`PUT ${bucket}/${key} answered ${status}: ${text}; check that the R2 token can write ${bucket}`);
};

const uploadFile = async (store, key, path) => {
  const digest = await sha256(path);
  const size = statSync(path).size;
  if (await exists(store, key)) {
    console.log(`kept ${key}`);
    return { digest, size };
  }
  await put(store, key, digest, { "content-type": "application/octet-stream" }, createReadStream(path), size);
  console.log(`uploaded ${key} (${size} bytes)`);
  return { digest, size };
};

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";

const uploadOci = async (store, prefix, layout) => {
  const index = JSON.parse(readFileSync(join(layout, "index.json"), "utf8"));
  const manifests = (index.manifests ?? []).filter((entry) => entry.mediaType === OCI_MANIFEST);
  if (manifests.length !== 1)
    die(
      `${layout}/index.json names ${manifests.length} image manifests, not one; pack the image again with npm run guest:image`,
    );
  const ociDigest = String(manifests[0].digest).replace(/^sha256:/, "");
  const blobs = join(layout, "blobs", "sha256");
  const names = readdirSync(blobs);
  if (!names.includes(ociDigest)) die(`${layout} lacks its manifest blob ${ociDigest}; pack the image again`);
  for (const name of names) {
    const path = join(blobs, name);
    const digest = await sha256(path);
    if (digest !== name) die(`${path} has digest ${digest}; pack the image again with npm run guest:image`);
    await uploadFile(store, `${prefix}/${name}`, path);
  }
  const manifest = JSON.parse(readFileSync(join(blobs, ociDigest), "utf8"));
  const config = JSON.parse(readFileSync(join(blobs, String(manifest.config.digest).replace(/^sha256:/, "")), "utf8"));
  const diffIds = (config.rootfs?.diff_ids ?? []).map((id) => String(id).replace(/^sha256:/, ""));
  if (diffIds.length !== 1)
    die(`${layout} names ${diffIds.length} layers, not one; pack the image again with npm run guest:image`);
  return { ociDigest, rootfsDigest: diffIds[0] };
};

const upload = async (arch, supervisorPath, cliPath, imageDir, fragmentPath) => {
  const architecture = ARCHITECTURES[arch];
  if (!architecture) die(`no architecture ${arch}; pass amd64 or arm64`);
  const store = storage();
  const supervisorDigest = await sha256(supervisorPath);
  const supervisor = await uploadFile(store, `supervisor/${arch}/${supervisorDigest}`, supervisorPath);
  const cliDigest = await sha256(cliPath);
  const cli = await uploadFile(store, `cli/${arch}/${cliDigest}`, cliPath);
  const manifests = readdirSync(imageDir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  if (manifests.length === 0) die(`${imageDir} holds no <imageDigest>.json; build the images with npm run guest:image`);
  const images = [];
  for (const name of manifests) {
    const manifestPath = join(imageDir, name);
    const manifest = GuestImageManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    const { harness, harnessVersion } = manifest.harness;
    const prefix = `images/${harness}/${harnessVersion}/${arch}`;
    const image = await uploadFile(
      store,
      `${prefix}/${manifest.imageDigest}`,
      join(imageDir, `${manifest.imageDigest}.ext4`),
    );
    const kernel = await uploadFile(
      store,
      `kernels/${arch}/${manifest.kernelDigest}`,
      join(imageDir, `${manifest.kernelDigest}.vmlinux`),
    );
    const manifestDigest = await sha256(manifestPath);
    await uploadFile(store, `${prefix}/${manifestDigest}`, manifestPath);
    const { ociDigest, rootfsDigest } = await uploadOci(
      store,
      `oci/${harness}/${harnessVersion}/${arch}`,
      join(imageDir, `oci-${manifest.imageDigest}`),
    );
    const rootfsTar = join(imageDir, `${manifest.imageDigest}.rootfs.tar`);
    const rootfsActual = await sha256(rootfsTar);
    if (rootfsActual !== rootfsDigest)
      die(
        `the OCI image of ${name} names layer ${rootfsDigest}, ${rootfsTar} is ${rootfsActual}; build the image again`,
      );
    await uploadFile(store, `${prefix}/rootfs/${rootfsDigest}`, rootfsTar);
    if (image.digest !== manifest.imageDigest)
      die(`${name} names image ${manifest.imageDigest}, the file is ${image.digest}`);
    if (kernel.digest !== manifest.kernelDigest)
      die(`${name} names kernel ${manifest.kernelDigest}, the file is ${kernel.digest}`);
    images.push({
      harness,
      harnessVersion,
      architecture,
      imageDigest: image.digest,
      kernelDigest: kernel.digest,
      manifestDigest,
      ociDigest,
      rootfsDigest,
    });
  }
  const fragment = FragmentSchema.parse({
    supervisor: { architecture, sha256: supervisor.digest, sizeBytes: supervisor.size },
    cli: { architecture, sha256: cli.digest, sizeBytes: cli.size },
    images,
  });
  mkdirSync(dirname(fragmentPath), { recursive: true });
  writeFileSync(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
  console.log(fragmentPath);
};

const headCommit = () => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) die("git rev-parse HEAD failed; run in the repository or set GITHUB_SHA");
  return result.stdout.trim();
};

const publish = async (fragmentDir) => {
  const files = readdirSync(fragmentDir, { recursive: true }).filter((name) => String(name).endsWith(".json"));
  if (files.length === 0)
    die(`${fragmentDir} holds no fragments; run release:publish upload for each architecture first`);
  const fragments = files.map((name) =>
    FragmentSchema.parse(JSON.parse(readFileSync(join(fragmentDir, String(name)), "utf8"))),
  );
  const commit = headCommit();
  const releaseVersion =
    process.env.GITHUB_REF_TYPE === "tag" ? required("GITHUB_REF_NAME") : `0.0.0-${commit.slice(0, 12)}`;
  const manifest = ReleaseManifestSchema.parse({
    releaseVersion,
    commit,
    channelProtocolVersion: ChannelProtocol.Version,
    supervisors: fragments.map((fragment) => fragment.supervisor),
    clis: fragments.map((fragment) => fragment.cli),
    images: fragments.flatMap((fragment) => fragment.images),
  });
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const digest = createHash("sha256").update(body).digest("hex");
  await put(
    storage(),
    "current.json",
    digest,
    { "content-type": "application/json", "cache-control": "no-cache" },
    body,
    Buffer.byteLength(body),
  );
  console.log(`published ${bucket}/current.json for ${releaseVersion} with ${manifest.images.length} images`);
};

const [command, ...args] = process.argv.slice(2);
if (command === "upload" && args.length === 5) await upload(...args);
else if (command === "manifest" && args.length === 1) await publish(args[0]);
else
  die(
    `usage: ${basename(process.argv[1])} upload <amd64|arm64> <supervisor binary> <cli binary> <image dir> <fragment.json> | manifest <fragment dir>`,
  );
