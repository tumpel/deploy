#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:https";
import { basename, dirname, join } from "node:path";
import {
  BaseImageManifestSchema,
  BaseLayout,
  GuestImageManifestSchema,
  GuestProtocol,
  HarnessLayerManifestSchema,
  ImageReleaseSchema,
  ReleaseHarnessLayerSchema,
  ReleaseManifestSchema,
} from "@tumpel/schemas";
import { fetched, github } from "./candidate-source.mjs";
import { controlPlaneModule, controlPlanePackage } from "./control-plane-source.mjs";
import { layerHarnesses, layerPrefix, layerRecipe, recipeKey } from "./harness-recipes.mjs";
import { disabledReason, RELEASE_ARCHITECTURES } from "./release-architectures.mjs";
import {
  CLI_REPOSITORY,
  cliAsset,
  downloadAsset,
  RELEASE_CACHE,
  releasePins,
  SUPERVISOR_REPOSITORY,
  supervisorAsset,
  supervisorRefusal,
  supervisorRelease,
} from "./release-download.mjs";
import { candidateFor, publishCandidate, readCandidate } from "./rollout.mjs";

const { CHECKSUM_HEADER, checksumOf, presignUrl } = await controlPlaneModule("packages/control-plane/src/presign.ts");
const { ChannelProtocol } = await controlPlanePackage("@tumpel/schemas");
for (const bound of ["Oldest", "Version"])
  if (!Number.isInteger(ChannelProtocol?.[bound]))
    throw new Error(
      `release:publish: the pinned control plane's @tumpel/schemas exports no integer ChannelProtocol.${bound}; update release-pins.json controlPlane or read the channel window from where that commit now keeps it`,
    );
const CONTROL_PLANE_CHANNEL = { Oldest: ChannelProtocol.Oldest, Version: ChannelProtocol.Version };

const ARCHITECTURES = { amd64: "Amd64", arm64: "Arm64" };
const ENABLED = new Set(RELEASE_ARCHITECTURES.map((arch) => ARCHITECTURES[arch]));
const CURRENT = "current.json";
const MONOREPO_LAST_RELEASE = "520a197fead3e84d534578cfcdb9c14c0f95a185";
const IMAGE_RELEASE = "images.json";
const IMAGE_RELEASE_TAG = /^images-v\d+\.\d+\.\d+$/;
const REQUEST_SECONDS = 900;
const SIGNED_SECONDS = 3600;

const ImageFragmentSchema = ReleaseManifestSchema.pick({ images: true });
const BaseFragmentSchema = ImageReleaseSchema.pick({ bases: true });
const PublishedImagesSchema = ImageReleaseSchema.pick({
  imageReleaseVersion: true,
  guestProtocolVersion: true,
  images: true,
  bases: true,
});
const LayerFragmentSchema = ReleaseManifestSchema.pick({ harnessLayers: true });
const LayerPlanSchema = LayerFragmentSchema.extend({
  harnessLayers: ReleaseHarnessLayerSchema.array(),
  missing: ReleaseHarnessLayerSchema.shape.harness.array(),
});
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
      response.on("end", () =>
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString(), headers: response.headers }),
      );
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
    return JSON.parse(text) ?? undefined;
  } catch (error) {
    return die(`${bucket}/${key} is not JSON (${String(error)}); publish it again`);
  }
};

const put = async (store, key, digest, headers, body, size) => {
  const url = await presignUrl(store.credentials, "PUT", store.origin, segmentsOf(key), SIGNED_SECONDS, new Date(), [
    [CHECKSUM_HEADER, checksumOf(digest)],
  ]);
  const {
    status,
    text,
    headers: responseHeaders,
  } = await send(
    url,
    "PUT",
    { ...headers, [CHECKSUM_HEADER]: checksumOf(digest), "content-length": String(size) },
    body,
  );
  if (status !== 200)
    throw new Error(`PUT ${bucket}/${key} answered ${status}: ${text}; check that the R2 token can write ${bucket}`);
  return responseHeaders.etag;
};

const putJson = async (store, key, value, conditions = {}) => {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const digest = createHash("sha256").update(body).digest("hex");
  return put(
    store,
    key,
    digest,
    { "content-type": "application/json", "cache-control": "no-cache", ...conditions },
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

const planLayers = async (arch, planPath) => {
  architectureOf(arch);
  const store = storage();
  const recipes = layerHarnesses().map((name) => layerRecipe(name, arch));
  const published = await Promise.all(recipes.map((recipe) => readJson(store, recipeKey(recipe))));
  const harnessLayers = published
    .filter((layer) => layer !== undefined)
    .map((layer) => ReleaseHarnessLayerSchema.parse(layer));
  const missing = recipes.filter((_, index) => published[index] === undefined).map((recipe) => recipe.harness.harness);
  for (const layer of harnessLayers)
    console.log(`kept layer ${layer.harness} ${layer.harnessVersion} ${arch} ${layer.layerDigest}`);
  for (const name of missing)
    console.log(`missing layer ${name} ${arch}; build it with npm run harness:layer -- ${name} ${arch}`);
  writeFragment(planPath, LayerPlanSchema.parse({ harnessLayers, missing }));
};

const uploadLayers = async (arch, planPath, layerDir, fragmentPath) => {
  const architecture = architectureOf(arch);
  const { harnessLayers, missing } = LayerPlanSchema.parse(JSON.parse(readFileSync(planPath, "utf8")));
  const store = storage();
  const built = missing.length === 0 ? [] : readdirSync(layerDir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  const manifests = built.map((name) => ({
    path: join(layerDir, name),
    manifest: HarnessLayerManifestSchema.parse(JSON.parse(readFileSync(join(layerDir, name), "utf8"))),
  }));
  const uploadLayer = async (name) => {
    const recipe = layerRecipe(name, arch);
    const match = manifests.find(({ manifest }) => manifest.recipeDigest === recipe.recipeDigest);
    if (!match)
      die(
        `${layerDir} holds no layer of recipe ${recipe.recipeDigest} for ${name}; build it with npm run harness:layer -- ${name} ${arch}`,
      );
    const { manifest, path } = match;
    if (manifest.architecture !== architecture)
      die(`${path} is built for ${manifest.architecture}, not ${architecture}`);
    const prefix = layerPrefix(recipe);
    const layer = await uploadFile(
      store,
      `${prefix}/${manifest.layerDigest}`,
      join(layerDir, `${manifest.layerDigest}.squashfs`),
    );
    if (layer.digest !== manifest.layerDigest)
      die(`${path} names layer ${manifest.layerDigest}, the file is ${layer.digest}`);
    const manifestDigest = await sha256(path);
    await uploadFile(store, `${prefix}/${manifestDigest}`, path);
    const released = ReleaseHarnessLayerSchema.parse({
      harness: recipe.harness.harness,
      harnessVersion: recipe.harness.harnessVersion,
      architecture,
      layerDigest: layer.digest,
      manifestDigest,
      sizeBytes: layer.size,
    });
    await putJson(store, recipeKey(recipe), released);
    console.log(`published layer ${name} ${recipe.harness.harnessVersion} ${arch} ${layer.digest}`);
    return released;
  };
  const uploaded = await Promise.all(missing.map(uploadLayer));
  writeFragment(fragmentPath, LayerFragmentSchema.parse({ harnessLayers: [...harnessLayers, ...uploaded] }));
};

const uploadBase = async (arch, baseDir, fragmentPath) => {
  const architecture = architectureOf(arch);
  const store = storage();
  const manifests = readdirSync(baseDir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  if (manifests.length !== 1)
    die(
      `${baseDir} holds ${manifests.length} <imageDigest>.json, not one; build the base with npm run guest:image -- base ${arch}`,
    );
  const manifestPath = join(baseDir, manifests[0]);
  const manifest = BaseImageManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (manifest.baseLayoutVersion !== BaseLayout.Version)
    die(
      `${manifestPath} carries base layout ${manifest.baseLayoutVersion}, this commit ${BaseLayout.Version}; build the base again`,
    );
  const prefix = `images/base/${arch}`;
  const image = await uploadFile(
    store,
    `${prefix}/${manifest.imageDigest}`,
    join(baseDir, `${manifest.imageDigest}.ext4`),
  );
  if (image.digest !== manifest.imageDigest)
    die(`${manifestPath} names image ${manifest.imageDigest}, the file is ${image.digest}`);
  const kernel = await uploadFile(
    store,
    `kernels/${arch}/${manifest.kernelDigest}`,
    join(baseDir, `${manifest.kernelDigest}.vmlinux`),
  );
  if (kernel.digest !== manifest.kernelDigest)
    die(`${manifestPath} names kernel ${manifest.kernelDigest}, the file is ${kernel.digest}`);
  const manifestDigest = await sha256(manifestPath);
  await uploadFile(store, `${prefix}/${manifestDigest}`, manifestPath);
  const { ociDigest, rootfsDigest } = await uploadOci(
    store,
    `oci/base/${arch}`,
    join(baseDir, `oci-${manifest.imageDigest}`),
  );
  const rootfsTar = join(baseDir, `${manifest.imageDigest}.rootfs.tar`);
  const rootfsActual = await sha256(rootfsTar);
  if (rootfsActual !== rootfsDigest)
    die(`the OCI image of the base names layer ${rootfsDigest}, ${rootfsTar} is ${rootfsActual}; build the base again`);
  await uploadFile(store, `${prefix}/rootfs/${rootfsDigest}`, rootfsTar);
  writeFragment(
    fragmentPath,
    BaseFragmentSchema.parse({
      bases: [
        {
          architecture,
          imageDigest: image.digest,
          kernelDigest: kernel.digest,
          manifestDigest,
          ociDigest,
          rootfsDigest,
        },
      ],
    }),
  );
};

const headCommit = () => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) die("git rev-parse HEAD failed; run in the repository or set GITHUB_SHA");
  return result.stdout.trim();
};

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });

const supersededBy = (commit, published) => {
  if (published === commit || published === MONOREPO_LAST_RELEASE) return false;
  if (git("cat-file", "-e", `${published}^{commit}`).status !== 0)
    return die(
      `${bucket}/${CURRENT} holds commit ${published}, which this checkout does not know; publish only from a commit of this repository, or fetch the branch that holds ${published}`,
    );
  const ancestor = git("merge-base", "--is-ancestor", commit, published);
  if (ancestor.status === 0) return true;
  if (ancestor.status === 1) return false;
  return die(
    `git merge-base --is-ancestor ${commit} ${published} failed: ${ancestor.stderr.trim()}; check out the full history (fetch-depth 0)`,
  );
};

const publishImageRelease = async (fragmentDir, baseFragmentDir) => {
  const imageReleaseVersion = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  if (!imageReleaseVersion || !IMAGE_RELEASE_TAG.test(imageReleaseVersion))
    die(
      `publish an image release only from a tag images-vX.Y.Z; this run is on ${process.env.GITHUB_REF_NAME ?? "(no ref)"}`,
    );
  const images = readFragments(fragmentDir, ImageFragmentSchema, "images").flatMap((fragment) => fragment.images);
  const missing = [...ENABLED].filter((architecture) => !images.some((image) => image.architecture === architecture));
  if (missing.length > 0)
    die(`the fragments hold no images for ${missing.join(", ")}; build them with npm run guest:image`);
  const bases = readFragments(baseFragmentDir, BaseFragmentSchema, "base").flatMap((fragment) => fragment.bases);
  const missingBases = [...ENABLED].filter((architecture) => !bases.some((base) => base.architecture === architecture));
  if (missingBases.length > 0)
    die(`the base fragments hold no base for ${missingBases.join(", ")}; build it with npm run guest:image -- base`);
  const release = ImageReleaseSchema.parse({
    imageReleaseVersion,
    commit: headCommit(),
    guestProtocolVersion: GuestProtocol.Version,
    images,
    baseLayoutVersion: BaseLayout.Version,
    bases,
  });
  await putJson(storage(), IMAGE_RELEASE, release);
  console.log(
    `published ${bucket}/${IMAGE_RELEASE} for ${imageReleaseVersion} with ${images.length} images and ${bases.length} bases; run the release workflow on main to carry them into ${CURRENT}`,
  );
};

const pinnedBinaries = async (imageGuestProtocolVersion) => {
  const pins = releasePins();
  const release = await supervisorRelease(pins.supervisor).catch((error) => die(error.message));
  const refusal = supervisorRefusal(release, CONTROL_PLANE_CHANNEL, GuestProtocol, imageGuestProtocolVersion);
  if (refusal !== undefined) die(refusal);
  const pinned = async (architecture) => {
    const listed = release.binaries.find((binary) => binary.architecture === architecture);
    if (!listed) die(`supervisor ${pins.supervisor} carries no ${architecture} binary; pin a release that does`);
    const [supervisor, cli] = await Promise.all([
      downloadAsset(SUPERVISOR_REPOSITORY, pins.supervisor, supervisorAsset(architecture), RELEASE_CACHE),
      downloadAsset(CLI_REPOSITORY, pins.cli, cliAsset(architecture), RELEASE_CACHE),
    ]).catch((error) => die(error.message));
    if (supervisor.digest !== listed.sha256)
      die(
        `release.json of supervisor ${pins.supervisor} names sha256 ${listed.sha256}, the asset is ${supervisor.digest}; pin a release whose assets match`,
      );
    console.log(
      `supervisor ${pins.supervisor} ${architecture} ${supervisor.digest}, CLI ${pins.cli} ${architecture} ${cli.digest}`,
    );
    return {
      supervisor: {
        architecture,
        sha256: supervisor.digest,
        sizeBytes: supervisor.sizeBytes,
        supervisorVersion: pins.supervisor,
        downloadUrl: supervisor.url,
        guestProtocolVersion: release.guestProtocolVersion,
      },
      cli: { architecture, sha256: cli.digest, sizeBytes: cli.sizeBytes, cliVersion: pins.cli, downloadUrl: cli.url },
    };
  };
  const binaries = await Promise.all([...ENABLED].map(pinned));
  return {
    pins,
    channelProtocolVersion: release.channelProtocolVersion,
    supervisors: binaries.map((binary) => binary.supervisor),
    clis: binaries.map((binary) => binary.cli),
  };
};

const publishRelease = async (layerFragmentDir) => {
  const harnessLayers = readFragments(layerFragmentDir, LayerFragmentSchema, "layers").flatMap(
    (fragment) => fragment.harnessLayers,
  );
  for (const architecture of ENABLED) {
    for (const name of layerHarnesses()) {
      if (!harnessLayers.some((layer) => layer.architecture === architecture && layer.harness === name))
        die(`the layer fragments hold no ${architecture} layer of ${name}; run release:publish layers first`);
    }
  }
  const store = storage();
  const imageRelease = await readJson(store, IMAGE_RELEASE);
  if (imageRelease === undefined)
    die(
      `${bucket}/${IMAGE_RELEASE} does not exist; push a tag images-vX.Y.Z to build and publish the guest images first`,
    );
  const { imageReleaseVersion, guestProtocolVersion, images, bases } = PublishedImagesSchema.parse(imageRelease);
  if (guestProtocolVersion < GuestProtocol.Oldest || guestProtocolVersion > GuestProtocol.Version)
    die(
      `${bucket}/${IMAGE_RELEASE} holds image release ${imageReleaseVersion}, whose guests speak guest protocol ${guestProtocolVersion}, and this commit speaks ${GuestProtocol.Oldest} to ${GuestProtocol.Version}; push a tag images-vX.Y.Z on this commit to publish matching images, then run the release workflow on main`,
    );
  const { pins, channelProtocolVersion, supervisors, clis } = await pinnedBinaries(guestProtocolVersion);
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
    channelProtocolVersion,
    supervisors,
    clis,
    images,
    harnessLayers,
    bases,
  });
  const candidate = candidateFor(
    readCandidate(new URL("../release-candidate.json", import.meta.url)),
    JSON.parse(readFileSync(new URL("../release-pins.json", import.meta.url), "utf8")),
    stage,
  );
  await publishCandidate(candidate, manifest, {
    get: async (key) => {
      const url = await presignUrl(store.credentials, "GET", store.origin, segmentsOf(key), SIGNED_SECONDS, new Date());
      const response = await send(url, "GET", {});
      if (response.status === 404) return undefined;
      if (response.status !== 200)
        throw new Error(`Release evidence read failed (${response.status}); keep main pins unchanged.`);
      return { value: JSON.parse(response.text), etag: response.headers.etag };
    },
    put: (key, value, conditions) => putJson(store, key, value, conditions),
    github,
    readiness: () => readJson(store, `readiness/${candidate.candidateId}.json`),
    endpoint: async () =>
      (
        await fetched(
          `https://api.${stage === "prod" ? "" : `${stage}.`}tumpel.dev/v1/releases/current?candidate=${candidate.candidateId}`,
        )
      ).json(),
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `candidate=${candidate !== undefined}\n`);
  console.log(
    `published ${bucket}/${CURRENT} for ${releaseVersion} with supervisor ${pins.supervisor}, CLI ${pins.cli} and the images of ${imageReleaseVersion}`,
  );
};

const [command, ...args] = process.argv.slice(2);
if (command === "images" && args.length === 3) await uploadImages(...args);
else if (command === "base" && args.length === 3) await uploadBase(...args);
else if (command === "image-release" && args.length === 2) await publishImageRelease(...args);
else if (command === "layer-plan" && args.length === 2) await planLayers(...args);
else if (command === "layers" && args.length === 4) await uploadLayers(...args);
else if (command === "manifest" && args.length === 1) await publishRelease(...args);
else
  die(
    `usage: ${basename(process.argv[1])} images <amd64|arm64> <image dir> <fragment.json> | base <amd64|arm64> <base dir> <fragment.json> | image-release <image fragment dir> <base fragment dir> | layer-plan <amd64|arm64> <plan.json> | layers <amd64|arm64> <plan.json> <layer dir> <fragment.json> | manifest <layer fragment dir>`,
  );
