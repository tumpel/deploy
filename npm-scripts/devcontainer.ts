export const DEVCONTAINER_PATHS = [".devcontainer/devcontainer.json", ".devcontainer.json"];
export const SETUP_COMMANDS = ["onCreateCommand", "updateContentCommand", "postCreateCommand"] as const;
export const START_COMMANDS = ["postStartCommand"] as const;

export type LifecycleCommand = (typeof SETUP_COMMANDS)[number] | (typeof START_COMMANDS)[number];

export type FindingCode =
  | "DevcontainerInvalid"
  | "PrebuildImageUnsupported"
  | "PrebuildFeaturesUnsupported"
  | "ToolchainMismatch";

export interface Finding {
  code: FindingCode;
  field: string;
  detail: string;
  fix: string;
}

export interface Command {
  lifecycle: LifecycleCommand;
  label: string;
  file: string;
  args: string[];
}

export interface Devcontainer {
  findings: Finding[];
  commands: Command[];
  containerEnv: Record<string, string>;
}

const UNSUPPORTED: Record<string, Omit<Finding, "field">> = {
  image: {
    code: "PrebuildImageUnsupported",
    detail: "names an image, and a prebuild builds on the tumpel guest image",
    fix: "remove image",
  },
  build: {
    code: "PrebuildImageUnsupported",
    detail: "names a build, and a prebuild builds on the tumpel guest image",
    fix: "remove build",
  },
  dockerFile: {
    code: "PrebuildImageUnsupported",
    detail: "names a dockerFile, and a prebuild builds on the tumpel guest image",
    fix: "remove dockerFile",
  },
  dockerComposeFile: {
    code: "PrebuildImageUnsupported",
    detail: "names a dockerComposeFile, and a prebuild runs one container",
    fix: "remove dockerComposeFile",
  },
  features: {
    code: "PrebuildFeaturesUnsupported",
    detail: "names features",
    fix: "remove features and install them from onCreateCommand instead",
  },
};

type Step = (text: string, index: number) => [string, number];

const outsideStrings = (text: string, step: Step): string => {
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

const withoutComments = (text: string): string =>
  outsideStrings(text, (source, index) => {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      return ["", end === -1 ? source.length : end];
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      return ["", end === -1 ? source.length : end + 2];
    }
    return [source[index] ?? "", index + 1];
  });

const CLOSER_AHEAD = /\s*[}\]]/y;

const withoutTrailingCommas = (text: string): string =>
  outsideStrings(text, (source, index) => {
    CLOSER_AHEAD.lastIndex = index + 1;
    return source[index] === "," && CLOSER_AHEAD.test(source) ? ["", index + 1] : [source[index] ?? "", index + 1];
  });

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

const parseJsonc = (text: string): Parsed => {
  try {
    return { ok: true, value: JSON.parse(withoutTrailingCommas(withoutComments(text))) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((entry) => typeof entry === "string");

const isStrings = (value: unknown): value is [string, ...string[]] =>
  Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string");

const invalid = (field: string, detail: string): Finding => ({
  code: "DevcontainerInvalid",
  field,
  detail,
  fix: "fix the file",
});

interface Read {
  commands: Command[];
  findings: Finding[];
}

const commandsOf = (lifecycle: LifecycleCommand, label: string, value: unknown, source: string): Read => {
  if (value === undefined) return { commands: [], findings: [] };
  if (typeof value === "string")
    return { commands: [{ lifecycle, label, file: "/bin/sh", args: ["-c", value] }], findings: [] };
  if (isStrings(value)) return { commands: [{ lifecycle, label, file: value[0], args: value.slice(1) }], findings: [] };
  if (!isObject(value) || label !== lifecycle)
    return {
      commands: [],
      findings: [
        invalid(
          label,
          label === lifecycle
            ? `${label} in ${source} is neither a string, an array nor an object`
            : `${label} in ${source} is neither a string nor an array`,
        ),
      ],
    };
  const entries = Object.entries(value).map(([key, entry]) => commandsOf(lifecycle, `${label}.${key}`, entry, source));
  return { commands: entries.flatMap((entry) => entry.commands), findings: entries.flatMap((entry) => entry.findings) };
};

const isUnsupported = (field: string, value: unknown): boolean =>
  value !== undefined && !(field === "features" && isObject(value) && Object.keys(value).length === 0);

export const checkDevcontainer = (config: unknown, source: string): Devcontainer => {
  if (!isObject(config))
    return { findings: [invalid(source, `${source} is not a JSON object`)], commands: [], containerEnv: {} };
  const unsupported = Object.entries(UNSUPPORTED)
    .filter(([field]) => isUnsupported(field, config[field]))
    .map(([field, { code, detail, fix }]): Finding => ({ code, field, detail: `${source} ${detail}`, fix }));
  const containerEnv = config.containerEnv;
  const containerEnvValid = containerEnv === undefined || isStringMap(containerEnv);
  const containerEnvFindings = containerEnvValid
    ? []
    : [invalid("containerEnv", `containerEnv in ${source} is not an object of strings`)];
  const lifecycle = [...SETUP_COMMANDS, ...START_COMMANDS].map((name) => commandsOf(name, name, config[name], source));
  return {
    findings: [...unsupported, ...containerEnvFindings, ...lifecycle.flatMap((entry) => entry.findings)],
    commands: lifecycle.flatMap((entry) => entry.commands),
    containerEnv: isStringMap(containerEnv) ? containerEnv : {},
  };
};

export const readDevcontainer = (text: string, path: string): Devcontainer => {
  const parsed = parseJsonc(text);
  if (!parsed.ok)
    return {
      findings: [invalid(path, `${path} is not JSON with comments (${parsed.message})`)],
      commands: [],
      containerEnv: {},
    };
  return checkDevcontainer(parsed.value, path);
};

const CONTAINER_ENV_REFERENCE = /\$\{containerEnv:([^}:]+)(?::([^}]*))?\}/g;

export const resolveContainerEnv = (
  base: Record<string, string>,
  containerEnv: Record<string, string>,
): Record<string, string> => ({
  ...base,
  ...Object.fromEntries(
    Object.entries(containerEnv).map(([name, value]) => [
      name,
      value.replace(
        CONTAINER_ENV_REFERENCE,
        (_, referenced: string, fallback: string | undefined) => base[referenced] ?? fallback ?? "",
      ),
    ]),
  ),
});

export const describeFinding = (finding: Finding): string => `${finding.code}: ${finding.detail}; ${finding.fix}`;
