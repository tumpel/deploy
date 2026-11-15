#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { basename, dirname, join } from "node:path";
import { ChannelProtocol, GuestImageManifestSchema, HostArchitectureSchema } from "@tumpel/api/schemas";
import { z } from "zod";
import { CHECKSUM_HEADER, checksumOf, presignUrl } from "../packages/control-plane/src/presign.ts";

const ARCHITECTURES = { amd64: "Amd64", arm64: "Arm64" };
const REQUEST_SECONDS = 900;
const SIGNED_SECONDS = 3600;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const InterimReleaseManifestSchema = z.object({
  version: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  channelProtocolVersion: z.int().min(1),
  supervisors: z
    .array(
      z.object({
        architecture: HostArchitectureSchema,
        url: z.url(),
        sha256: Sha256Schema,
        size: z.int().min(1),
      }),
    )
    .min(1),
  images: z
    .array(
      z.object({
        harness: z.string().min(1),
        harnessVersion: z.string().min(1),
        architecture: HostArchitectureSchema,
        imageUrl: z.url(),
        imageDigest: Sha256Schema,
        kernelUrl: z.url(),
        kernelDigest: Sha256Schema,
        manifestDigest: Sha256Schema,
      }),
    )
    .min(1),
});

const FragmentSchema = InterimReleaseManifestSchema.pick({ images: true }).extend({
  supervisor: InterimReleaseManifestSchema.shape.supervisors.element,
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
const baseUrl =
  process.env.RELEASES_BASE_URL || `https://tumpel-control-plane-${stage}.matthijs-f49.workers.dev/v1/releases`;

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
    return { url: `${baseUrl}/${key}`, digest, size };
  }
  await put(store, key, digest, { "content-type": "application/octet-stream" }, createReadStream(path), size);
  console.log(`uploaded ${key} (${size} bytes)`);
  return { url: `${baseUrl}/${key}`, digest, size };
};

const upload = async (arch, supervisorPath, imageDir, fragmentPath) => {
  const architecture = ARCHITECTURES[arch];
  if (!architecture) die(`no architecture ${arch}; pass amd64 or arm64`);
  const store = storage();
  const supervisorDigest = await sha256(supervisorPath);
  const supervisor = await uploadFile(store, `supervisor/${arch}/${supervisorDigest}`, supervisorPath);
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
    if (image.digest !== manifest.imageDigest)
      die(`${name} names image ${manifest.imageDigest}, the file is ${image.digest}`);
    if (kernel.digest !== manifest.kernelDigest)
      die(`${name} names kernel ${manifest.kernelDigest}, the file is ${kernel.digest}`);
    images.push({
      harness,
      harnessVersion,
      architecture,
      imageUrl: image.url,
      imageDigest: image.digest,
      kernelUrl: kernel.url,
      kernelDigest: kernel.digest,
      manifestDigest,
    });
  }
  const fragment = FragmentSchema.parse({
    supervisor: { architecture, url: supervisor.url, sha256: supervisor.digest, size: supervisor.size },
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
  const version = process.env.GITHUB_REF_TYPE === "tag" ? required("GITHUB_REF_NAME") : `0.0.0-${commit.slice(0, 12)}`;
  const manifest = InterimReleaseManifestSchema.parse({
    version,
    commit,
    channelProtocolVersion: ChannelProtocol.Version,
    supervisors: fragments.map((fragment) => fragment.supervisor),
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
  console.log(`published ${bucket}/current.json for ${version} with ${manifest.images.length} images`);
};

const [command, ...args] = process.argv.slice(2);
if (command === "upload" && args.length === 4) await upload(...args);
else if (command === "manifest" && args.length === 1) await publish(args[0]);
else
  die(
    `usage: ${basename(process.argv[1])} upload <amd64|arm64> <supervisor binary> <image dir> <fragment.json> | manifest <fragment dir>`,
  );
