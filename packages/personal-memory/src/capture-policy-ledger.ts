import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

export type SensitiveCategory = "credentials" | "financial" | "identity";

export interface CapturePolicyStatus {
  revision: number;
  captureEnabled: boolean;
  excludedClients: readonly ("codex" | "claude-code")[];
  excludedWorkingDirectories: readonly string[];
  excludedSources: readonly "agent_lifecycle"[];
  sensitiveCategories: readonly SensitiveCategory[];
  l0RetentionDays: number | null;
  l1RetentionDays: number | null;
  changedAt: string;
}

interface PolicyRow {
  revision: number;
  capture_enabled: number;
  excluded_clients_json: string;
  excluded_working_directories_json: string;
  excluded_sources_json: string;
  sensitive_categories_json: string;
  l0_retention_days: number | null;
  l1_retention_days: number | null;
  changed_at: string;
}

export class CapturePolicyConflictError extends Error {
  constructor() {
    super("Capture policy changed; reload it before updating");
    this.name = "CapturePolicyConflictError";
  }
}

function parseList<T extends string>(value: string): readonly T[] {
  return JSON.parse(value) as T[];
}

function toStatus(row: PolicyRow): CapturePolicyStatus {
  return {
    revision: row.revision,
    captureEnabled: row.capture_enabled === 1,
    excludedClients: parseList(row.excluded_clients_json),
    excludedWorkingDirectories: parseList(
      row.excluded_working_directories_json,
    ),
    excludedSources: parseList(row.excluded_sources_json),
    sensitiveCategories: parseList(row.sensitive_categories_json),
    l0RetentionDays: row.l0_retention_days,
    l1RetentionDays: row.l1_retention_days,
    changedAt: row.changed_at,
  };
}

function isPaymentCardNumber(value: string): boolean {
  const digits = value.replaceAll(/[ -]/gu, "");
  if (!/^\d{13,19}$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double && (digit *= 2) > 9) digit -= 9;
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function containsCredential(value: string): boolean {
  return [
    /(?:api[_ -]?key|password|passwd|secret|token)\s*(?::|=|\bis\b)\s*\S{6,}/iu,
    /\bauthorization\s*:\s*bearer\s+\S{6,}/iu,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ].some((rule) => rule.test(value));
}

export class CapturePolicyLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!this.currentRow()) {
      this.insert({
        revision: 1,
        captureEnabled: true,
        excludedClients: [],
        excludedWorkingDirectories: [],
        excludedSources: [],
        sensitiveCategories: ["credentials", "financial", "identity"],
        l0RetentionDays: null,
        l1RetentionDays: null,
        changedAt: this.now(),
      });
    }
  }

  status(): CapturePolicyStatus {
    return toStatus(this.currentRow()!);
  }

  history(
    input: { limit?: number; beforeRevision?: number } = {},
  ): readonly CapturePolicyStatus[] {
    const limit = input.limit ?? 50;
    const rows =
      input.beforeRevision === undefined
        ? this.database
            .prepare(
              `SELECT * FROM personalmemory_capture_policies ORDER BY revision DESC LIMIT ?`,
            )
            .all(limit)
        : this.database
            .prepare(
              `SELECT * FROM personalmemory_capture_policies WHERE revision < ? ORDER BY revision DESC LIMIT ?`,
            )
            .all(input.beforeRevision, limit);
    return (rows as unknown as PolicyRow[]).map(toStatus);
  }

  update(
    input: Omit<CapturePolicyStatus, "revision" | "changedAt"> & {
      expectedRevision: number;
    },
  ): CapturePolicyStatus {
    const current = this.currentRow()!;
    if (input.expectedRevision !== current.revision)
      throw new CapturePolicyConflictError();
    const next: CapturePolicyStatus = {
      ...input,
      excludedWorkingDirectories: input.excludedWorkingDirectories.map(
        (directory) => resolve(directory),
      ),
      revision: current.revision + 1,
      changedAt: this.now(),
    };
    this.insert(next);
    return next;
  }

  allowsSource(input: {
    client: "codex" | "claude-code";
    workingDirectory: string;
    source: "agent_lifecycle";
  }): boolean {
    const policy = this.status();
    if (
      !policy.captureEnabled ||
      policy.excludedClients.includes(input.client) ||
      policy.excludedSources.includes(input.source)
    )
      return false;
    const workingDirectory = resolve(input.workingDirectory);
    return !policy.excludedWorkingDirectories.some((configuredDirectory) => {
      const directory = resolve(configuredDirectory);
      return (
        directory === "/" ||
        workingDirectory === directory ||
        workingDirectory.startsWith(`${directory}/`)
      );
    });
  }

  sensitiveCategory(text: string): SensitiveCategory | undefined {
    const enabled = new Set(this.status().sensitiveCategories);
    const rules: readonly [SensitiveCategory, (value: string) => boolean][] = [
      ["credentials", containsCredential],
      [
        "financial",
        (value) => value.split(/[^\d -]+/u).some(isPaymentCardNumber),
      ],
      ["identity", (value) => /\b\d{17}[\dXx]\b/u.test(value)],
    ];
    return rules.find(
      ([category, matches]) => enabled.has(category) && matches(text),
    )?.[0];
  }

  private currentRow(): PolicyRow | undefined {
    return this.database
      .prepare(
        `SELECT * FROM personalmemory_capture_policies ORDER BY revision DESC LIMIT 1`,
      )
      .get() as PolicyRow | undefined;
  }

  private insert(policy: CapturePolicyStatus): void {
    this.database
      .prepare(
        `INSERT INTO personalmemory_capture_policies
      (revision, capture_enabled, excluded_clients_json, excluded_working_directories_json,
       excluded_sources_json, sensitive_categories_json, l0_retention_days, l1_retention_days, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        policy.revision,
        policy.captureEnabled ? 1 : 0,
        JSON.stringify(policy.excludedClients),
        JSON.stringify(policy.excludedWorkingDirectories),
        JSON.stringify(policy.excludedSources),
        JSON.stringify(policy.sensitiveCategories),
        policy.l0RetentionDays,
        policy.l1RetentionDays,
        policy.changedAt,
      );
  }
}
