export interface GatewayStatus {
  readonly authenticationConfigured: boolean;
  readonly modelConfigured: boolean;
}

const CSRF_STORAGE_KEY = "personalmemory.csrf";

export async function createBrowserSession(token: string): Promise<void> {
  const response = await fetch("/api/v1/session", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    credentials: "same-origin",
  });
  const body = (await response.json().catch(() => ({}))) as {
    csrfToken?: unknown;
    error?: { code?: string };
  };
  if (!response.ok || typeof body.csrfToken !== "string") {
    throw new GatewayRequestError(
      response.status,
      body.error?.code ?? "SESSION_FAILED",
    );
  }
  sessionStorage.setItem(CSRF_STORAGE_KEY, body.csrfToken);
}

export type MemoryLevel = "L0" | "L1" | "L2" | "L3";

export type AuditAction =
  | "memory.generated"
  | "memory.reviewed"
  | "memory.recalled"
  | "memory.updated"
  | "memory.invalidated"
  | "memory.deleted"
  | "memory.relation_created"
  | "memory.relation_revoked"
  | "memory.validity_updated"
  | "data.exported";

export interface AuditEvent {
  readonly sequence: number;
  readonly event_id: string;
  readonly action: AuditAction;
  readonly outcome: "success" | "failure";
  readonly subject?: {
    readonly level: MemoryLevel;
    readonly reference: string;
  };
  readonly details: Record<
    string,
    string | number | boolean | string[] | number[]
  >;
  readonly occurred_at: string;
}

export interface AuditResponse {
  readonly events: AuditEvent[];
  readonly next_before_sequence?: number;
}

export async function fetchAudit(
  input: {
    action?: AuditAction;
    level?: MemoryLevel;
    memoryId?: string;
    beforeSequence?: number;
    limit?: number;
  } = {},
  signal?: AbortSignal,
): Promise<AuditResponse> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.action) params.set("action", input.action);
  if (input.level) params.set("level", input.level);
  if (input.memoryId) params.set("memory_id", input.memoryId);
  if (input.beforeSequence)
    params.set("before_sequence", String(input.beforeSequence));
  const response = await fetch(`/api/v1/audit?${params}`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`审计时间线请求失败（${response.status}）`);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray(Reflect.get(body, "events"))
  ) {
    throw new Error("Gateway 返回了无法识别的审计时间线");
  }
  return body as AuditResponse;
}

export interface MemoryListItem {
  readonly id: string;
  readonly level: MemoryLevel;
  readonly title: string;
  readonly content: string;
  readonly updated_at?: string;
  readonly score?: number;
  readonly state: {
    readonly status: "active";
    readonly revision: number;
  };
  readonly source: {
    readonly status: "original" | "unavailable";
    readonly label: string;
    readonly explanation: string;
  };
  readonly review?: {
    readonly status: "pending" | "approved" | "rejected";
    readonly revision: number;
    readonly reason?: string;
  };
  readonly governance?: MemoryGovernance;
}

export interface MemoryValidity {
  readonly level: "L1" | "L2" | "L3";
  readonly memoryId: string;
  readonly validFrom?: string;
  readonly expiresAt?: string;
  readonly revision: number;
  readonly updatedAt?: string;
}

export interface MemoryRelation {
  readonly id: string;
  readonly level: "L1" | "L2" | "L3";
  readonly kind: "conflicts_with" | "supersedes";
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly status: "active" | "revoked";
  readonly reason: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryGovernance {
  readonly recallable: boolean;
  readonly validity: MemoryValidity;
  readonly relations: MemoryRelation[];
}

export interface MemoryMutationState {
  readonly status: "active" | "invalidated" | "deleted";
  readonly revision: number;
}

export class GatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Gateway 请求失败（${status}，${code}）`);
    this.name = "GatewayRequestError";
  }
}

interface ErrorBody {
  error?: { code?: string };
}

async function postMemoryMutation<T>(
  item: MemoryListItem,
  action: "update" | "invalidate" | "delete",
  body: object,
): Promise<T> {
  const response = await fetch(
    `/api/v1/memories/${item.level}/${encodeURIComponent(item.id)}/${action}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(sessionStorage.getItem(CSRF_STORAGE_KEY)
          ? {
              "X-CSRF-Token": sessionStorage.getItem(CSRF_STORAGE_KEY)!,
            }
          : {}),
      },
      credentials: "same-origin",
      body: JSON.stringify(body),
    },
  );
  const parsed = (await response.json().catch(() => ({}))) as ErrorBody;
  if (!response.ok) {
    throw new GatewayRequestError(
      response.status,
      parsed.error?.code ?? "UNKNOWN_ERROR",
    );
  }
  return parsed as T;
}

export function updateMemory(item: MemoryListItem, content: string) {
  return postMemoryMutation<{ state: MemoryMutationState }>(item, "update", {
    content,
    expected_revision: item.state.revision,
  });
}

export function invalidateMemory(item: MemoryListItem, reason: string) {
  return postMemoryMutation<{ state: MemoryMutationState }>(
    item,
    "invalidate",
    { reason, expected_revision: item.state.revision },
  );
}

export interface ControlledDeleteResponse {
  readonly state: MemoryMutationState;
  readonly upstream_deleted: boolean;
  readonly scope: {
    readonly hidden_from_personalmemory: true;
    readonly complete_erasure: false;
  };
}

export function deleteMemory(
  item: MemoryListItem,
  reason: string,
  confirmation: string,
) {
  return postMemoryMutation<ControlledDeleteResponse>(item, "delete", {
    reason,
    confirmation,
    expected_revision: item.state.revision,
  });
}

export interface PrivacyDeletionPreview {
  readonly token: string;
  readonly level: "L1";
  readonly memory_id: string;
  readonly expires_at: string;
  readonly confirmation: string;
  readonly scope: {
    readonly source_l0: number;
    readonly index_l1: number;
    readonly derived_l2: number;
    readonly derived_l3: number;
    readonly readable_l0: number;
    readonly readable_l1: number;
    readonly managed_copies: number;
  };
  readonly managed_copies: ReadonlyArray<{
    readonly id: string;
    readonly kind: "readable_export" | "portable_backup";
    readonly path: string;
  }>;
  readonly limitations: readonly string[];
}

export interface PrivacyDeletionResult {
  readonly status: "complete" | "partial";
  readonly memory_id: string;
  readonly retryable: boolean;
  readonly verification: {
    readonly l1_remaining: number;
    readonly l0_remaining: number;
    readonly derived_occurrences: number;
    readonly readable_rows: number;
    readonly managed_copies_remaining: number;
    readonly tombstone_present: boolean;
  };
  readonly errors: ReadonlyArray<{
    readonly step: string;
    readonly code: string;
  }>;
}

async function postPrivacyDeletion<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(sessionStorage.getItem(CSRF_STORAGE_KEY)
        ? { "X-CSRF-Token": sessionStorage.getItem(CSRF_STORAGE_KEY)! }
        : {}),
    },
    credentials: "same-origin",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = (await response.json().catch(() => ({}))) as ErrorBody;
  if (!response.ok) {
    throw new GatewayRequestError(
      response.status,
      parsed.error?.code ?? "UNKNOWN_ERROR",
    );
  }
  return parsed as T;
}

export function previewPrivacyDeletion(
  item: MemoryListItem,
): Promise<PrivacyDeletionPreview> {
  return postPrivacyDeletion("/api/v1/privacy-deletions/preview", {
    level: "L1",
    memory_id: item.id,
  });
}

export async function cancelPrivacyDeletion(token: string): Promise<void> {
  await postPrivacyDeletion(
    `/api/v1/privacy-deletions/${encodeURIComponent(token)}/cancel`,
  );
}

export function executePrivacyDeletion(
  preview: PrivacyDeletionPreview,
  confirmation: string,
): Promise<PrivacyDeletionResult> {
  return postPrivacyDeletion(
    `/api/v1/privacy-deletions/${encodeURIComponent(preview.token)}/execute`,
    {
      confirmation,
      delete_managed_copies: true,
      unmanaged_copies_acknowledged: true,
    },
  );
}

export interface MemoryListResponse {
  readonly items: MemoryListItem[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number | null;
  readonly has_previous: boolean;
  readonly has_next: boolean;
}

export async function fetchMemories(
  input: {
    level: MemoryLevel;
    query: string;
    page: number;
    reviewStatus?: "pending" | "approved" | "rejected";
  },
  signal?: AbortSignal,
): Promise<MemoryListResponse> {
  const params = new URLSearchParams({
    level: input.level,
    query: input.query,
    page: String(input.page),
    page_size: "12",
  });
  if (input.reviewStatus) params.set("review_status", input.reviewStatus);
  const response = await fetch(`/api/v1/memories?${params}`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`记忆列表请求失败（${response.status}）`);
  }
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray(Reflect.get(body, "items")) ||
    typeof Reflect.get(body, "page") !== "number" ||
    typeof Reflect.get(body, "has_previous") !== "boolean" ||
    typeof Reflect.get(body, "has_next") !== "boolean"
  ) {
    throw new Error("Gateway 返回了无法识别的记忆列表");
  }
  return body as MemoryListResponse;
}

export interface ReviewBatchItem {
  readonly id: string;
  readonly action: "approve" | "reject";
  readonly expected_revision: number;
  readonly content?: string;
  readonly reason?: string;
}

export async function reviewMemories(items: ReviewBatchItem[]): Promise<void> {
  const response = await fetch("/api/v1/memory-reviews", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(sessionStorage.getItem(CSRF_STORAGE_KEY)
        ? { "X-CSRF-Token": sessionStorage.getItem(CSRF_STORAGE_KEY)! }
        : {}),
    },
    credentials: "same-origin",
    body: JSON.stringify({ items }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    results?: Array<{ ok: boolean; code?: string }>;
    error?: { code?: string };
  };
  if (!response.ok || body.results?.some((result) => !result.ok)) {
    throw new GatewayRequestError(
      response.status,
      body.error?.code ??
        body.results?.find((result) => !result.ok)?.code ??
        "REVIEW_FAILED",
    );
  }
}

async function governanceRequest(
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(sessionStorage.getItem(CSRF_STORAGE_KEY)
        ? { "X-CSRF-Token": sessionStorage.getItem(CSRF_STORAGE_KEY)! }
        : {}),
    },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const error = result.error as { code?: string } | undefined;
    throw new GatewayRequestError(
      response.status,
      error?.code ?? "GOVERNANCE_FAILED",
    );
  }
  return result;
}

export async function setMemoryValidity(
  item: MemoryListItem,
  validFrom?: string,
  expiresAt?: string,
): Promise<void> {
  await governanceRequest(
    `/api/v1/memories/${item.level}/${encodeURIComponent(item.id)}/validity`,
    {
      valid_from: validFrom || null,
      expires_at: expiresAt || null,
      expected_revision: item.governance?.validity.revision ?? 0,
    },
  );
}

export async function addMemoryRelation(input: {
  level: "L1" | "L2" | "L3";
  kind: "conflicts_with" | "supersedes";
  sourceId: string;
  targetId: string;
  reason: string;
  mergedContent?: string;
}): Promise<void> {
  await governanceRequest("/api/v1/memory-relations", {
    level: input.level,
    kind: input.kind,
    source_id: input.sourceId,
    target_id: input.targetId,
    reason: input.reason,
    ...(input.mergedContent ? { merged_content: input.mergedContent } : {}),
  });
}

export async function revokeMemoryRelation(
  relation: MemoryRelation,
): Promise<void> {
  await governanceRequest(
    `/api/v1/memory-relations/${encodeURIComponent(relation.id)}/revoke`,
    { expected_revision: relation.revision },
  );
}

export async function fetchGatewayStatus(
  signal?: AbortSignal,
): Promise<GatewayStatus> {
  const options: RequestInit = {
    headers: { Accept: "application/json" },
  };
  if (signal) options.signal = signal;

  const response = await fetch("/api/v1/config/status", options);

  if (!response.ok) {
    throw new Error(`Gateway 状态请求失败（${response.status}）`);
  }

  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    typeof Reflect.get(body, "authenticationConfigured") !== "boolean" ||
    typeof Reflect.get(body, "modelConfigured") !== "boolean"
  ) {
    throw new Error("Gateway 返回了无法识别的状态");
  }

  return body as GatewayStatus;
}
