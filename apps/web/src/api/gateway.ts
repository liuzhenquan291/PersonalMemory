export interface GatewayStatus {
  readonly authenticationConfigured: boolean;
  readonly modelConfigured: boolean;
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
