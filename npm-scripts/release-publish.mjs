#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { basename, dirname, join } from "node:path";
import {
  ChannelProtocol,
  GuestImageManifestSchema,
  ImageReleaseSchema,
  ReleaseManifestSchema,
} from "@tumpel/api/schemas";
import { CHECKSUM_HEADER, checksumOf, presignUrl } from "../packages/control-plane/src/presign.ts";
import { disabledReason, RELEASE_ARCHITECTURES } from "./release-architectures.mjs";

const ARCHITECTURES = { amd64: "Amd64", arm64: "Arm64" };
const ENABLED = new Set(RELEASE_ARCHITECTURES.map((arch) => ARCHITECTURES[arch]));
const CURRENT = "current.json";
const IMAGE_RELEASE = "images.json";
const IMAGE_RELEASE_TAG = /^images-v\d+\.\d+\.\d+$/;
const REQUEST_SECONDS = 900;
const SIGNED_SECONDS = 3600;

const BinaryFragmentSchema = ReleaseManifestSchema.pick({ supervisors: true, clis: true });
const ImageFragmentSchema = ReleaseManifestSchema.pick({ images: true });
const PublishedCommitSchema = ReleaseManifestSchema.pick({ commit: true });

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

const readJson = async (store, key) => {
  const url = await presignUrl(store.credentials, "GET", store.origin, segmentsOf(key), SIGNED_SECONDS, new Date());
  const { status, text } = await send(url, "GET", {});
  if (status === 404) return undefined;
  if (status !== 200)
    die(`GET ${bucket}/${key} answered ${status}: ${text}; check that the R2 token can read ${bucket}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    return die(`${bucket}/${key} is not JSON (${String(error)}); publish it again`);
  }
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

const putJson = async (store, key, value) => {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const digest = createHash("sha256").update(body).digest("hex");
  await put(
    store,
    key,
    digest,
    { "content-type": "application/json", "cache-control": "no-cache" },
    body,
    Buffer.byteLength(body),
  );
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

const architectureOf = (arch) => {
  const architecture = ARCHITECTURES[arch];
  if (!architecture) die(`no architecture ${arch}; pass amd64 or arm64`);
  if (!ENABLED.has(architecture)) die(disabledReason(arch));
  return architecture;
};

const writeFragment = (fragmentPath, fragment) => {
  mkdirSync(dirname(fragmentPath), { recursive: true });
  writeFileSync(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
  console.log(fragmentPath);
};

const readFragments = (fragmentDir, schema, command) => {
  const files = readdirSync(fragmentDir, { recursive: true }).filter((name) => String(name).endsWith(".json"));
  if (files.length === 0) die(`${fragmentDir} holds no fragments; run release:publish ${command} first`);
  return files.map((name) => schema.parse(JSON.parse(readFileSync(join(fragmentDir, String(name)), "utf8"))));
};

const uploadBinaries = async (arch, supervisorPath, cliPath, fragmentPath) => {
  const architecture = architectureOf(arch);
  const store = storage();
  const uploadBinary = async (binary, path) => {
    const digest = await sha256(path);
    const uploaded = await uploadFile(store, `${binary}/${arch}/${digest}`, path);
    return { architecture, sha256: uploaded.digest, sizeBytes: uploaded.size };
  };
  const [supervisor, cli] = await Promise.all([
    uploadBinary("supervisor", supervisorPath),
    uploadBinary("cli", cliPath),
  ]);
  writeFragment(fragmentPath, BinaryFragmentSchema.parse({ supervisors: [supervisor], clis: [cli] }));
};

const uploadImages = async (arch, imageDir, fragmentPath) => {
  const architecture = architectureOf(arch);
  const store = storage();
  const manifests = readdirSync(imageDir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  if (manifests.length === 0) die(`${imageDir} holds no <imageDigest>.json; build the images with npm run guest:image`);
  const uploadImage = async (name) => {
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
    return {
      harness,
      harnessVersion,
      architecture,
      imageDigest: image.digest,
      kernelDigest: kernel.digest,
      manifestDigest,
      ociDigest,
      rootfsDigest,
    };
  };
  const images = await Promise.all(manifests.map(uploadImage));
  writeFragment(fragmentPath, ImageFragmentSchema.parse({ images }));
};

const headCommit = () => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) die("git rev-parse HEAD failed; run in the repository or set GITHUB_SHA");
  return result.stdout.trim();
};

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

const supersededBy = (commit, published) => {
  if (published === commit) return false;
  if (git("cat-file", "-e", `${published}^{commit}`).status !== 0) return false;
  const ancestor = git("merge-base", "--is-ancestor", commit, published);
  if (ancestor.status === 0) return true;
  if (ancestor.status === 1) return false;
  return die(
    `git merge-base --is-ancestor ${commit} ${published} failed: ${ancestor.stderr.trim()}; check out the full history (fetch-depth 0)`,
  );
};

const publishImageRelease = async (fragmentDir) => {
  const imageReleaseVersion = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  if (!imageReleaseVersion || !IMAGE_RELEASE_TAG.test(imageReleaseVersion))
    die(
      `publish an image release only from a tag images-vX.Y.Z; this run is on ${process.env.GITHUB_REF_NAME ?? "(no ref)"}`,
    );
  const images = readFragments(fragmentDir, ImageFragmentSchema, "images").flatMap((fragment) => fragment.images);
  const missing = [...ENABLED].filter((architecture) => !images.some((image) => image.architecture === architecture));
  if (missing.length > 0)
    die(`the fragments hold no images for ${missing.join(", ")}; build them with npm run guest:image`);
  const release = ImageReleaseSchema.parse({ imageReleaseVersion, commit: headCommit(), images });
  const store = storage();
  await putJson(store, IMAGE_RELEASE, release);
  console.log(`published ${bucket}/${IMAGE_RELEASE} for ${imageReleaseVersion} with ${images.length} images`);
  const current = await readJson(store, CURRENT);
  if (current === undefined) {
    console.log(`${bucket}/${CURRENT} does not exist yet; the next release from main carries these images`);
    return;
  }
  const manifest = ReleaseManifestSchema.parse({ ...ReleaseManifestSchema.parse(current), images });
  await putJson(store, CURRENT, manifest);
  console.log(
    `published ${bucket}/${CURRENT} for ${manifest.releaseVersion} with the images of ${imageReleaseVersion}`,
  );
};

const publishRelease = async (fragmentDir) => {
  const fragments = readFragments(fragmentDir, BinaryFragmentSchema, "binaries");
  const supervisors = fragments.flatMap((fragment) => fragment.supervisors);
  const clis = fragments.flatMap((fragment) => fragment.clis);
  for (const architecture of new Set([...supervisors, ...clis].map((binary) => binary.architecture))) {
    if (!ENABLED.has(architecture)) die(disabledReason(architecture.toLowerCase()));
  }
  for (const architecture of ENABLED) {
    if (!supervisors.some((supervisor) => supervisor.architecture === architecture))
      die(`the fragments hold no ${architecture} supervisor; run release:publish binaries first`);
    if (!clis.some((cli) => cli.architecture === architecture))
      die(`the fragments hold no ${architecture} CLI; run release:publish binaries first`);
  }
  const store = storage();
  const imageRelease = await readJson(store, IMAGE_RELEASE);
  if (imageRelease === undefined)
    die(
      `${bucket}/${IMAGE_RELEASE} does not exist; push a tag images-vX.Y.Z to build and publish the guest images first`,
    );
  const { imageReleaseVersion, images } = ImageReleaseSchema.parse(imageRelease);
  const commit = headCommit();
  const current = await readJson(store, CURRENT);
  if (current !== undefined) {
    const published = PublishedCommitSchema.parse(current).commit;
    if (supersededBy(commit, published)) {
      if (process.env.GITHUB_REF_TYPE === "tag")
        die(`${bucket}/${CURRENT} holds ${published}, which descends from ${commit}; tag a newer commit`);
      console.log(`kept ${bucket}/${CURRENT}: it holds ${published}, which descends from ${commit}`);
      return;
    }
  }
  const releaseVersion =
    process.env.GITHUB_REF_TYPE === "tag" ? required("GITHUB_REF_NAME") : `0.0.0-${commit.slice(0, 12)}`;
  const manifest = ReleaseManifestSchema.parse({
    releaseVersion,
    commit,
    channelProtocolVersion: ChannelProtocol.Version,
    supervisors,
    clis,
    images,
  });
  await putJson(store, CURRENT, manifest);
  console.log(`published ${bucket}/${CURRENT} for ${releaseVersion} with the images of ${imageReleaseVersion}`);
};

const [command, ...args] = process.argv.slice(2);
if (command === "binaries" && args.length === 4) await uploadBinaries(...args);
else if (command === "images" && args.length === 3) await uploadImages(...args);
else if (command === "image-release" && args.length === 1) await publishImageRelease(args[0]);
else if (command === "manifest" && args.length === 1) await publishRelease(args[0]);
else
  die(
    `usage: ${basename(process.argv[1])} binaries <amd64|arm64> <supervisor binary> <cli binary> <fragment.json> | images <amd64|arm64> <image dir> <fragment.json> | image-release <fragment dir> | manifest <fragment dir>`,
  );
