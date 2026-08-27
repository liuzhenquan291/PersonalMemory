import {
  CapturePolicyLedger,
  RetentionAuthorizationLedger,
  applyRetentionRestoreEnvelope,
  defaultMigrations,
  migrateDatabase,
  parseRetentionRestoreSnapshot,
} from "@personalmemory/core";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { PrivacyDeletionService } from "../apps/gateway/src/privacy-deletions.js";
import { FetchUpstreamGatewayClient } from "../apps/gateway/src/upstream-client.js";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { TdaiGateway } from "../src/gateway/server.js";

export async function prepareRetentionRestoreStaging(input: {
  stagingDirectory: string;
  envelope: unknown;
  deferredArtifactPath: string;
  now?: () => Date;
}): Promise<{ status: "disabled" | "drained" }> {
  const database = new DatabaseSync(
    path.join(input.stagingDirectory, "personalmemory.sqlite"),
  );
  let upstream: TdaiGateway | undefined;
  try {
    migrateDatabase(database, defaultMigrations);
    const parsed = parseRetentionRestoreSnapshot(input.envelope);
    if (parsed.envelope.payload.authorization?.status === "authorized") {
      const stagingInstallation = database
        .prepare(
          `SELECT installation_id FROM personalmemory_hook_authorizations
           ORDER BY authorization_revision DESC LIMIT 1`,
        )
        .get() as { installation_id: string } | undefined;
      if (
        stagingInstallation?.installation_id !==
        parsed.envelope.payload.installation_id
      )
        throw new Error("Retention restore installation identity mismatch");
    }
    applyRetentionRestoreEnvelope(database, input.envelope, {
      deferredArtifactPath: path.resolve(input.deferredArtifactPath),
    });
    const policy = new CapturePolicyLedger(database).status();
    const authorization = new RetentionAuthorizationLedger(database).status(
      policy,
    );
    if (
      parsed.envelope.payload.authorization?.status === "authorized" &&
      authorization.status !== "authorized"
    )
      throw new Error("Retention restore disclosure or binding mismatch");
    if (authorization.status !== "authorized") return { status: "disabled" };

    const base = loadGatewayConfig();
    upstream = new TdaiGateway({
      ...base,
      deployMode: "standalone",
      stateBackend: "local",
      server: { ...base.server, host: "127.0.0.1", port: 0 },
      data: { ...base.data, baseDir: input.stagingDirectory },
      llm: { ...base.llm, enabled: false, baseUrl: "", apiKey: "", model: "" },
      memory: {
        ...base.memory,
        storeBackend: "sqlite",
        embedding: {
          ...base.memory.embedding,
          enabled: false,
          provider: "none",
          baseUrl: "",
          apiKey: "",
          proxyUrl: "",
        },
        tcvdb: {
          ...base.memory.tcvdb,
          url: "",
          apiKey: "",
          database: "",
          alias: "",
        },
      },
      observability: {
        ...base.observability,
        otel: { ...base.observability.otel, enabled: false },
        clickhouse: { ...base.observability.clickhouse, enabled: false },
        kafka: { ...base.observability.kafka, enabled: false, brokers: "" },
        langfuse: { ...base.observability.langfuse, enabled: false },
        barad: base.observability.barad
          ? { ...base.observability.barad, enabled: false }
          : undefined,
        zhiyan: base.observability.zhiyan
          ? { ...base.observability.zhiyan, enabled: false }
          : undefined,
      },
    });
    await upstream.start();
    const address = upstream.getListeningAddress();
    const client = new FetchUpstreamGatewayClient(
      new URL(`http://${address.host}:${address.port}`),
    );
    const deletions = new PrivacyDeletionService(
      database,
      input.stagingDirectory,
      client,
      30_000,
      input.now ? () => input.now!().getTime() : undefined,
    );
    const cutoff = (days: number | null): string | null => {
      if (days === null) return null;
      const date = input.now?.() ?? new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (days - 1));
      return date.toISOString();
    };
    const cutoffs = {
      cutoffL0: cutoff(policy.l0RetentionDays),
      cutoffL1: cutoff(policy.l1RetentionDays),
    };
    for (let batch = 0; batch < 10_000; batch += 1) {
      const result = await deletions.executeRetentionBatch(
        cutoffs,
        `restore-retention-${batch}`,
      );
      if (result.status === "drained") return { status: "drained" };
      if (result.status !== "draining")
        throw new Error(result.error_code ?? "RETENTION_RESTORE_PARTIAL");
    }
    throw new Error("Retention restore exceeded the bounded batch limit");
  } finally {
    await upstream?.stop().catch(() => undefined);
    database.close();
  }
}
