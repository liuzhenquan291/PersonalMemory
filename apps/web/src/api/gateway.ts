export interface GatewayStatus {
  readonly authenticationConfigured: boolean;
  readonly modelConfigured: boolean;
}

export type MemoryLevel = "L0" | "L1" | "L2" | "L3";

export interface MemoryListItem {
  readonly id: string;
  readonly level: MemoryLevel;
  readonly title: string;
  readonly content: string;
  readonly updated_at?: string;
  readonly score?: number;
  readonly source: {
    readonly status: "original" | "unavailable";
    readonly label: string;
    readonly explanation: string;
  };
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
  input: { level: MemoryLevel; query: string; page: number },
  signal?: AbortSignal,
): Promise<MemoryListResponse> {
  const params = new URLSearchParams({
    level: input.level,
    query: input.query,
    page: String(input.page),
    page_size: "12",
  });
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
