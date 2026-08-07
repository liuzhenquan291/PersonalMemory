import os from "node:os";
import path from "node:path";
import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const booleanFromEnvironment = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const fileConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65_535).optional(),
        authenticationEnabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dataDirectory: z.string().min(1).optional(),
    telemetryEnabled: z.boolean().optional(),
    model: z
      .object({
        enabled: z.boolean().optional(),
        provider: z.enum(["local", "openai-compatible"]).optional(),
        baseUrl: z.url().optional(),
        allowedOrigins: z.array(z.url()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type FileConfig = z.input<typeof fileConfigSchema>;

export interface PersonalMemoryConfig {
  server: {
    host: string;
    port: number;
    authenticationEnabled: boolean;
    authenticationToken?: SecretValue;
  };
  dataDirectory: string;
  telemetryEnabled: boolean;
  model: {
    enabled: boolean;
    provider?: "local" | "openai-compatible";
    baseUrl?: URL;
    allowedOrigins: readonly string[];
    apiKey?: SecretValue;
  };
}

export type ConfigurationReadiness =
  { ready: true } | { ready: false; reason: "model-configuration-required" };

export interface LoadedConfig {
  config: PersonalMemoryConfig;
  readiness: ConfigurationReadiness;
}

export interface ModelOutboundDisclosure {
  provider: "local" | "openai-compatible";
  targetOrigin: string;
  sentFields: readonly ["model input", "selected memory context"];
}

export class ConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

export class SecretValue {
  readonly #value: string;

  constructor(value: string, name: string) {
    if (!value.trim()) {
      throw new ConfigurationError(`${name} must not be empty`);
    }
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}

export function defaultDataDirectory(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  if (platform === "darwin") {
    return path.join(
      homeDirectory,
      "Library",
      "Application Support",
      "PersonalMemory",
    );
  }
  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  return path.join(
    xdgDataHome || path.join(homeDirectory, ".local", "share"),
    "personalmemory",
  );
}

function parseEnvironmentBoolean(
  environment: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  const parsed = booleanFromEnvironment.safeParse(value.toLowerCase());
  if (!parsed.success) {
    throw new ConfigurationError(`${name} must be true, false, 1, or 0`);
  }
  return parsed.data;
}

function parsePort(environment: NodeJS.ProcessEnv): number | undefined {
  const value = environment.PERSONALMEMORY_PORT;
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError(
      "PERSONALMEMORY_PORT must be an integer from 1 to 65535",
    );
  }
  return port;
}

function normalizeOrigins(origins: readonly string[]): string[] {
  try {
    return [
      ...new Set(
        origins.map((origin) => {
          const url = new URL(origin);
          if (
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
          ) {
            throw new TypeError("allowlist entries must be origins");
          }
          if (!isLoopback(url.hostname) && url.protocol !== "https:") {
            throw new ConfigurationError(
              "Remote model allowlist origins require HTTPS",
            );
          }
          return url.origin;
        }),
      ),
    ];
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      "PERSONALMEMORY_MODEL_ALLOWED_ORIGINS must contain absolute URLs",
      { cause: error },
    );
  }
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function loadConfig(
  options: {
    file?: unknown;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homeDirectory?: string;
  } = {},
): LoadedConfig {
  const environment = options.environment ?? process.env;
  const parsedFile = fileConfigSchema.safeParse(options.file ?? {});
  if (!parsedFile.success) {
    throw new ConfigurationError(
      `Invalid PersonalMemory configuration: ${z.prettifyError(parsedFile.error)}`,
      { cause: parsedFile.error },
    );
  }
  const file = parsedFile.data;
  const host =
    environment.PERSONALMEMORY_HOST ?? file.server?.host ?? "127.0.0.1";
  const port = parsePort(environment) ?? file.server?.port ?? 8787;
  const authenticationEnabled =
    parseEnvironmentBoolean(environment, "PERSONALMEMORY_AUTH_ENABLED") ??
    file.server?.authenticationEnabled ??
    false;
  const authenticationTokenValue = environment.PERSONALMEMORY_AUTH_TOKEN;

  if (!isLoopback(host) && !authenticationEnabled) {
    throw new ConfigurationError(
      "Non-loopback listening requires authentication; set PERSONALMEMORY_AUTH_ENABLED=true and PERSONALMEMORY_AUTH_TOKEN",
    );
  }
  if (authenticationEnabled && !authenticationTokenValue?.trim()) {
    throw new ConfigurationError(
      "Authentication is enabled but PERSONALMEMORY_AUTH_TOKEN is missing",
    );
  }

  const modelEnabled =
    parseEnvironmentBoolean(environment, "PERSONALMEMORY_MODEL_ENABLED") ??
    file.model?.enabled ??
    false;
  const provider =
    environment.PERSONALMEMORY_MODEL_PROVIDER ?? file.model?.provider;
  if (
    provider !== undefined &&
    provider !== "local" &&
    provider !== "openai-compatible"
  ) {
    throw new ConfigurationError(
      "PERSONALMEMORY_MODEL_PROVIDER must be local or openai-compatible",
    );
  }
  const baseUrlValue =
    environment.PERSONALMEMORY_MODEL_BASE_URL ?? file.model?.baseUrl;
  let baseUrl: URL | undefined;
  try {
    baseUrl = baseUrlValue ? new URL(baseUrlValue) : undefined;
  } catch (error) {
    throw new ConfigurationError(
      "PERSONALMEMORY_MODEL_BASE_URL must be an absolute URL",
      { cause: error },
    );
  }
  const environmentOrigins = environment.PERSONALMEMORY_MODEL_ALLOWED_ORIGINS;
  const allowedOrigins = normalizeOrigins(
    environmentOrigins === undefined
      ? (file.model?.allowedOrigins ?? [])
      : environmentOrigins
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
  );
  const apiKeyValue = environment.PERSONALMEMORY_MODEL_API_KEY;

  if (modelEnabled && (!provider || !baseUrl)) {
    throw new ConfigurationError(
      "Model access is enabled but provider or base URL is missing",
    );
  }
  if (modelEnabled && baseUrl) {
    const localEndpoint = isLoopback(baseUrl.hostname);
    if (
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password
    ) {
      throw new ConfigurationError(
        "The model base URL must use HTTP(S) and must not contain credentials",
      );
    }
    if (!localEndpoint && baseUrl.protocol !== "https:") {
      throw new ConfigurationError("Remote model access requires HTTPS");
    }
    if (provider === "local" && !localEndpoint) {
      throw new ConfigurationError(
        "The local provider must use a loopback URL",
      );
    }
    if (
      provider === "openai-compatible" &&
      !allowedOrigins.includes(baseUrl.origin)
    ) {
      throw new ConfigurationError(
        `Remote model origin ${baseUrl.origin} is not in PERSONALMEMORY_MODEL_ALLOWED_ORIGINS`,
      );
    }
    if (provider === "openai-compatible" && !apiKeyValue?.trim()) {
      throw new ConfigurationError(
        "The openai-compatible provider requires PERSONALMEMORY_MODEL_API_KEY",
      );
    }
  }

  const config: PersonalMemoryConfig = {
    server: {
      host,
      port,
      authenticationEnabled,
      ...(authenticationTokenValue
        ? {
            authenticationToken: new SecretValue(
              authenticationTokenValue,
              "PERSONALMEMORY_AUTH_TOKEN",
            ),
          }
        : {}),
    },
    dataDirectory: path.resolve(
      environment.PERSONALMEMORY_DATA_DIR ??
        file.dataDirectory ??
        defaultDataDirectory(
          options.platform,
          environment,
          options.homeDirectory,
        ),
    ),
    telemetryEnabled:
      parseEnvironmentBoolean(
        environment,
        "PERSONALMEMORY_TELEMETRY_ENABLED",
      ) ??
      file.telemetryEnabled ??
      false,
    model: {
      enabled: modelEnabled,
      ...(provider ? { provider } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      allowedOrigins,
      ...(apiKeyValue
        ? {
            apiKey: new SecretValue(
              apiKeyValue,
              "PERSONALMEMORY_MODEL_API_KEY",
            ),
          }
        : {}),
    },
  };

  return {
    config,
    readiness: modelEnabled
      ? { ready: true }
      : { ready: false, reason: "model-configuration-required" },
  };
}

export function assertOutboundAllowed(
  target: string | URL,
  config: PersonalMemoryConfig,
): URL {
  const url = target instanceof URL ? target : new URL(target);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new ConfigurationError(
      "Outbound model targets must use HTTP(S) without URL credentials",
    );
  }
  if (!isLoopback(url.hostname) && url.protocol !== "https:") {
    throw new ConfigurationError("Remote model access requires HTTPS");
  }
  if (!config.model.enabled) {
    throw new ConfigurationError(
      "Model network access is disabled; enable and configure a provider first",
    );
  }
  if (config.model.provider === "local") {
    if (!isLoopback(url.hostname)) {
      throw new ConfigurationError(
        "The local provider cannot access remote hosts",
      );
    }
  } else if (!config.model.allowedOrigins.includes(url.origin)) {
    throw new ConfigurationError(
      `Outbound origin ${url.origin} is not in the model provider allowlist`,
    );
  }
  return url;
}

export function getModelOutboundDisclosure(
  config: PersonalMemoryConfig,
): ModelOutboundDisclosure | undefined {
  if (
    !config.model.enabled ||
    !config.model.provider ||
    !config.model.baseUrl
  ) {
    return undefined;
  }
  return {
    provider: config.model.provider,
    targetOrigin: config.model.baseUrl.origin,
    sentFields: ["model input", "selected memory context"],
  };
}
