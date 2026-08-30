import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  getModelOutboundDisclosure,
  loadConfig,
  type PersonalMemoryConfig,
} from "@personalmemory/core";
import type {
  ModelConfigurationManager,
  ModelConfigurationStatus,
} from "./types.js";

const MANAGED_KEYS = new Set([
  "PERSONALMEMORY_AUTH_ENABLED",
  "PERSONALMEMORY_AUTH_TOKEN",
  "PERSONALMEMORY_MODEL_ENABLED",
  "PERSONALMEMORY_MODEL_PROVIDER",
  "PERSONALMEMORY_MODEL_BASE_URL",
  "PERSONALMEMORY_MODEL_ALLOWED_ORIGINS",
  "PERSONALMEMORY_MODEL_API_KEY",
  "PERSONALMEMORY_MODEL_NAME",
]);

function parseEnvironment(contents: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const line of contents.trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Gateway environment is malformed");
    const key = line.slice(0, separator);
    if (!MANAGED_KEYS.has(key) || Object.hasOwn(environment, key)) {
      throw new Error("Gateway environment contains an unmanaged field");
    }
    environment[key] = line.slice(separator + 1);
  }
  return environment;
}

function serializeEnvironment(environment: NodeJS.ProcessEnv): string {
  return `${[...MANAGED_KEYS]
    .filter((key) => environment[key] !== undefined)
    .map((key) => `${key}=${environment[key]}`)
    .join("\n")}\n`;
}

function modelFingerprint(model: PersonalMemoryConfig["model"]): string {
  return JSON.stringify({
    enabled: model.enabled,
    provider: model.provider,
    baseUrl: model.baseUrl?.href,
    allowedOrigins: model.allowedOrigins,
    modelName: model.name,
    apiKey: model.apiKey?.reveal(),
  });
}

function view(
  config: PersonalMemoryConfig,
  activeConfig: PersonalMemoryConfig,
): ModelConfigurationStatus {
  const { model } = config;
  const disclosure = getModelOutboundDisclosure(config);
  return {
    enabled: model.enabled,
    ...(model.provider === "openai-compatible"
      ? { provider: model.provider }
      : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl.href } : {}),
    ...(model.name ? { modelName: model.name } : {}),
    apiKeyConfigured: Boolean(model.apiKey),
    ...(disclosure?.provider === "openai-compatible"
      ? { disclosure: { ...disclosure, provider: disclosure.provider } }
      : {}),
    restartRequired:
      modelFingerprint(model) !== modelFingerprint(activeConfig.model),
  };
}

async function writePrivateAtomic(
  target: string,
  contents: string,
): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createModelConfigurationManager(options: {
  secretPath: string;
  activeConfig: PersonalMemoryConfig;
}): Promise<ModelConfigurationManager> {
  const info = await lstat(options.secretPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("Gateway environment must be a private regular file");
  }
  let environment = parseEnvironment(
    await readFile(options.secretPath, "utf8"),
  );

  const configuredConfig = () => loadConfig({ environment }).config;
  configuredConfig();

  return {
    status: () => view(configuredConfig(), options.activeConfig),
    async configure(input) {
      const baseUrl = new URL(input.baseUrl);
      environment = {
        ...environment,
        PERSONALMEMORY_MODEL_ENABLED: "true",
        PERSONALMEMORY_MODEL_PROVIDER: input.provider,
        PERSONALMEMORY_MODEL_BASE_URL: baseUrl.href,
        PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: baseUrl.origin,
        PERSONALMEMORY_MODEL_API_KEY: input.apiKey,
        PERSONALMEMORY_MODEL_NAME: input.modelName,
      };
      configuredConfig();
      await writePrivateAtomic(
        options.secretPath,
        serializeEnvironment(environment),
      );
      return view(configuredConfig(), options.activeConfig);
    },
    async disable() {
      environment = {
        PERSONALMEMORY_AUTH_ENABLED: environment.PERSONALMEMORY_AUTH_ENABLED,
        PERSONALMEMORY_AUTH_TOKEN: environment.PERSONALMEMORY_AUTH_TOKEN,
        PERSONALMEMORY_MODEL_ENABLED: "false",
      };
      configuredConfig();
      await writePrivateAtomic(
        options.secretPath,
        serializeEnvironment(environment),
      );
      return view(configuredConfig(), options.activeConfig);
    },
  };
}
