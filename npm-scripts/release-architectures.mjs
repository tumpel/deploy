export const BUILD_ARM64 = process.env.BUILD_ARM64 === "true";
export const RELEASE_ARCHITECTURES = BUILD_ARM64 ? ["amd64", "arm64"] : ["amd64"];
export const disabledReason = (arch) =>
  `${arch} is not built: the release builds ${RELEASE_ARCHITECTURES.join(", ")}; set BUILD_ARM64=true once an arm64 host passes the proof`;
