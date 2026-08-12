import { describe, expect, it, vi } from "vitest";
import { searchMemoriesInputSchema } from "../src/contract.js";
import type { PersonalMemoryGatewayClient } from "../src/gateway-client.js";
import { PersonalMemoryMcpService } from "../src/service.js";

describe("PersonalMemoryMcpService", () => {
  it("binds opaque cursors to an identical search request", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          items: [
            {
              id: "approved-1",
              level: "L1",
              content: "first",
              score: 1,
              source_reference_count: 1,
              review: { status: "approved", revision: 1 },
              truncated: false,
            },
          ],
          degraded_levels: [],
          page: { offset: 0, count: 1, has_more: true },
          budget: { used_chars: 5, estimated_tokens: 2, exhausted: true },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          items: [],
          degraded_levels: [],
          page: { offset: 1, count: 0, has_more: false },
          budget: { used_chars: 0, estimated_tokens: 0, exhausted: false },
        },
      });
    const gateway = { post } as unknown as PersonalMemoryGatewayClient;
    const service = new PersonalMemoryMcpService(
      gateway,
      () => 1_000,
      () => "cursor-1",
    );
    const input = searchMemoriesInputSchema.parse({ query: "project" });
    const first = await service.search(input);
    expect(first.page.next_cursor).toBe("cursor-1");
    expect(first.items[0]?.source).toEqual({
      status: "original",
      reference_count: 1,
      references_truncated: true,
    });
    await expect(
      service.search({ ...input, query: "changed", cursor: "cursor-1" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const second = await service.search({ ...input, cursor: "cursor-1" });
    expect(second.page.has_more).toBe(false);
    expect(post).toHaveBeenLastCalledWith(
      "/api/v1/recall/query",
      expect.objectContaining({ offset: 1 }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("never returns an internal deletion plan token", async () => {
    const post = vi.fn(async () => ({
      status: 200,
      data: {
        handoff_id: "web-handoff-1",
        expires_at: "2026-08-12T12:00:00.000Z",
        scope: {
          source_l0: 1,
          index_l1: 1,
          derived_l2: 0,
          derived_l3: 0,
          readable_l0: 1,
          readable_l1: 1,
          managed_copies: 0,
        },
        limitations: ["controlled scope"],
      },
    }));
    const service = new PersonalMemoryMcpService({
      post,
    } as unknown as PersonalMemoryGatewayClient);
    const output = await service.prepareForget({ memory_id: "memory-1" });
    expect(output).toMatchObject({
      handoff_id: "web-handoff-1",
      web_confirmation_required: true,
      destructive_action_performed: false,
    });
    expect(JSON.stringify(output)).not.toContain("token");
    expect(post).toHaveBeenCalledWith(
      "/api/v1/privacy-deletions/handoffs",
      { level: "L1", memory_id: "memory-1" },
      expect.anything(),
      expect.anything(),
    );
  });
});
