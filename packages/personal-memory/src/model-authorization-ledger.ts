import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ModelOutboundDisclosure } from "./config.js";

export type ModelAuthorizationStatus =
  | { status: "required"; revision: 0 }
  | { status: "stale"; revision: number }
  | { status: "authorized"; revision: number; authorizedAt: string }
  | { status: "revoked"; revision: number; revokedAt: string };

interface AuthorizationRow {
  revision: number;
  disclosure_hash: string;
  status: "authorized" | "revoked";
  authorized_at: string | null;
  revoked_at: string | null;
}

function canonicalDisclosure(disclosure: ModelOutboundDisclosure): string {
  return JSON.stringify({
    version: disclosure.version,
    provider: disclosure.provider,
    targetOrigin: disclosure.targetOrigin,
    sentFields: disclosure.sentFields,
  });
}

function disclosureHash(disclosure: ModelOutboundDisclosure): string {
  return createHash("sha256")
    .update(canonicalDisclosure(disclosure))
    .digest("hex");
}

export class ModelAuthorizationLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  status(disclosure: ModelOutboundDisclosure): ModelAuthorizationStatus {
    const current = this.current();
    if (!current) return { status: "required", revision: 0 };
    if (current.disclosure_hash !== disclosureHash(disclosure)) {
      return { status: "stale", revision: current.revision };
    }
    if (current.status === "authorized") {
      return {
        status: "authorized",
        revision: current.revision,
        authorizedAt: current.authorized_at!,
      };
    }
    return {
      status: "revoked",
      revision: current.revision,
      revokedAt: current.revoked_at!,
    };
  }

  authorize(disclosure: ModelOutboundDisclosure): ModelAuthorizationStatus {
    return this.transition(disclosure, "authorized");
  }

  revoke(disclosure: ModelOutboundDisclosure): ModelAuthorizationStatus {
    return this.transition(disclosure, "revoked");
  }

  private transition(
    disclosure: ModelOutboundDisclosure,
    target: "authorized" | "revoked",
  ): ModelAuthorizationStatus {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const status = this.status(disclosure);
      if (status.status === target) {
        this.database.exec("COMMIT");
        return status;
      }
      const changed = this.append(disclosure, target);
      this.database.exec("COMMIT");
      return changed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private current(): AuthorizationRow | undefined {
    return this.database
      .prepare(
        `SELECT revision, disclosure_hash, status, authorized_at, revoked_at
         FROM personalmemory_model_authorizations
         ORDER BY revision DESC LIMIT 1`,
      )
      .get() as AuthorizationRow | undefined;
  }

  private append(
    disclosure: ModelOutboundDisclosure,
    status: "authorized" | "revoked",
  ): ModelAuthorizationStatus {
    const revision = (this.current()?.revision ?? 0) + 1;
    const timestamp = this.now();
    this.database
      .prepare(
        `INSERT INTO personalmemory_model_authorizations
         (revision, disclosure_version, disclosure_hash, provider,
          target_origin, sent_fields_json, status, authorized_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision,
        disclosure.version,
        disclosureHash(disclosure),
        disclosure.provider,
        disclosure.targetOrigin,
        JSON.stringify(disclosure.sentFields),
        status,
        status === "authorized" ? timestamp : null,
        status === "revoked" ? timestamp : null,
      );
    return status === "authorized"
      ? { status, revision, authorizedAt: timestamp }
      : { status, revision, revokedAt: timestamp };
  }
}
