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
