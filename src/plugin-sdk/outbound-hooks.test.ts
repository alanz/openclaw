import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { EmitOutboundMessageSentParams } from "./outbound-hooks.js";

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(),
}));

vi.mock("../hooks/fire-and-forget.js", () => ({
  fireAndForgetHook: vi.fn(),
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  triggerInternalHook: vi.fn().mockResolvedValue(undefined),
  createInternalHookEvent: vi.fn((type, action, sessionKey, context) => ({
    type,
    action,
    sessionKey,
    context,
  })),
}));

vi.mock("../hooks/message-hook-mappers.js", () => ({
  buildCanonicalSentMessageHookContext: vi.fn((p) => ({ ...p, conversationId: p.to })),
  toPluginMessageSentEvent: vi.fn((c) => ({ to: c.to, content: c.content, success: c.success })),
  toPluginMessageContext: vi.fn((c) => ({
    channelId: c.channelId,
    accountId: c.accountId,
    conversationId: c.conversationId,
  })),
  toInternalMessageSentContext: vi.fn((c) => ({ to: c.to, content: c.content })),
}));

describe("emitOutboundMessageSent", () => {
  // Resolved after mocks are hoisted so we get the mock instances.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: Record<string, any>;
  let emitOutboundMessageSent: (params: EmitOutboundMessageSentParams) => void;

  const mockRunMessageSent = vi.fn().mockResolvedValue(undefined);
  const mockHookRunner = { hasHooks: vi.fn(), runMessageSent: mockRunMessageSent };

  beforeAll(async () => {
    m = {
      getGlobalHookRunner: (await import("../plugins/hook-runner-global.js")).getGlobalHookRunner,
      fireAndForgetHook: (await import("../hooks/fire-and-forget.js")).fireAndForgetHook,
      createInternalHookEvent: (await import("../hooks/internal-hooks.js")).createInternalHookEvent,
      triggerInternalHook: (await import("../hooks/internal-hooks.js")).triggerInternalHook,
      buildCanonicalSentMessageHookContext: (await import("../hooks/message-hook-mappers.js"))
        .buildCanonicalSentMessageHookContext,
    };
    ({ emitOutboundMessageSent } = await import("./outbound-hooks.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no hook runner is available", () => {
    m.getGlobalHookRunner.mockReturnValue(null);

    emitOutboundMessageSent({
      channelId: "deltachat",
      to: "user@example.com",
      content: "hello",
      success: true,
    });

    expect(m.fireAndForgetHook).not.toHaveBeenCalled();
  });

  it("does nothing when hook runner has no message_sent hooks and no sessionKey", () => {
    m.getGlobalHookRunner.mockReturnValue(mockHookRunner);
    mockHookRunner.hasHooks.mockReturnValue(false);

    emitOutboundMessageSent({
      channelId: "deltachat",
      to: "user@example.com",
      content: "hello",
      success: true,
    });

    expect(m.fireAndForgetHook).not.toHaveBeenCalled();
  });

  it("fires plugin message_sent hook when hook runner has hooks", () => {
    m.getGlobalHookRunner.mockReturnValue(mockHookRunner);
    mockHookRunner.hasHooks.mockReturnValue(true);

    emitOutboundMessageSent({
      channelId: "deltachat",
      to: "user@example.com",
      content: "hello",
      success: true,
      messageId: "42",
      accountId: "1",
    });

    expect(m.fireAndForgetHook).toHaveBeenCalledTimes(1);
    expect(mockRunMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com", content: "hello", success: true }),
      expect.objectContaining({ channelId: "deltachat" }),
    );
  });

  it("fires internal message:sent hook when sessionKey is provided", () => {
    m.getGlobalHookRunner.mockReturnValue(mockHookRunner);
    mockHookRunner.hasHooks.mockReturnValue(false);

    emitOutboundMessageSent({
      channelId: "deltachat",
      to: "user@example.com",
      content: "hello",
      success: true,
      sessionKey: "sess:abc123",
    });

    expect(m.fireAndForgetHook).toHaveBeenCalledTimes(1);
    expect(m.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "sess:abc123",
      expect.any(Object),
    );
    expect(m.triggerInternalHook).toHaveBeenCalled();
  });

  it("fires both hooks when hook runner has hooks and sessionKey is provided", () => {
    m.getGlobalHookRunner.mockReturnValue(mockHookRunner);
    mockHookRunner.hasHooks.mockReturnValue(true);

    emitOutboundMessageSent({
      channelId: "deltachat",
      to: "user@example.com",
      content: "hello",
      success: true,
      sessionKey: "sess:abc123",
    });

    expect(m.fireAndForgetHook).toHaveBeenCalledTimes(2);
  });

  it("passes success=false and error for failed sends", () => {
    m.getGlobalHookRunner.mockReturnValue(mockHookRunner);
    mockHookRunner.hasHooks.mockReturnValue(true);

    emitOutboundMessageSent({
      channelId: "deltachat",
      to: "user@example.com",
      content: "hello",
      success: false,
      error: "RPC timeout",
    });

    expect(mockRunMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.any(Object),
    );
    expect(m.buildCanonicalSentMessageHookContext).toHaveBeenCalledWith(
      expect.objectContaining({ error: "RPC timeout" }),
    );
  });

  it("passes isGroup and groupId through to canonical context builder", () => {
    m.getGlobalHookRunner.mockReturnValue(mockHookRunner);
    mockHookRunner.hasHooks.mockReturnValue(true);

    emitOutboundMessageSent({
      channelId: "deltachat",
      to: "789",
      content: "group msg",
      success: true,
      isGroup: true,
      groupId: "789",
    });

    expect(m.buildCanonicalSentMessageHookContext).toHaveBeenCalledWith(
      expect.objectContaining({ isGroup: true, groupId: "789" }),
    );
  });
});
