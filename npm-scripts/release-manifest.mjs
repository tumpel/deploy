import { ReleaseManifestSchema } from "@tumpel/schemas";

const PublishedSupervisorSchema = ReleaseManifestSchema.pick({ supervisors: true, rollback: true });

const order = (version) => {
  const [, major, minor, patch, candidate] = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(version);
  return [
    Number(major),
    Number(minor),
    Number(patch),
    candidate === undefined ? Number.MAX_SAFE_INTEGER : Number(candidate),
  ];
};

const compare = (left, right) => {
  const a = order(left);
  const b = order(right);
  return a.map((part, index) => Math.sign(part - b[index])).find((sign) => sign !== 0) ?? 0;
};

export const releaseManifest = (fields, current) => {
  const pinned = fields.supervisors[0].supervisorVersion;
  const published = current === undefined ? undefined : PublishedSupervisorSchema.parse(current);
  const version = published?.supervisors[0]?.supervisorVersion;
  const direction = version === undefined ? 1 : compare(pinned, version);
  const rollback = direction < 0 || (direction === 0 && published.rollback === true);
  return ReleaseManifestSchema.parse({ ...fields, ...(rollback && { rollback: true }) });
};
