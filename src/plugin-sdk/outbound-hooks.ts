import { fireAndForgetHook } from "../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../hooks/message-hook-mappers.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";

export type EmitOutboundMessageSentParams = {
  channelId: string;
  to: string;
  content: string;
  success: boolean;
  error?: string;
  messageId?: string;
  accountId?: string;
  isGroup?: boolean;
  groupId?: string;
  /**
   * Session key for the internal message:sent hook. Comes from route.sessionKey
   * in the inbound monitor. When omitted only the plugin-level hook fires.
   */
  sessionKey?: string;
};

/**
 * Fires message_sent plugin hooks and the internal message:sent hook for plugin
 * channels that manage their own outbound delivery path (i.e. are not routed
 * through deliverOutboundPayloads). Pass sessionKey to also emit the internal hook.
 */
export function emitOutboundMessageSent(params: EmitOutboundMessageSentParams): void {
  const hookRunner = getGlobalHookRunner();
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  const canEmitInternalHook = Boolean(params.sessionKey);
  if (!hasMessageSentHooks && !canEmitInternalHook) {
    return;
  }
  const canonical = buildCanonicalSentMessageHookContext({
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: params.channelId,
    accountId: params.accountId,
    conversationId: params.to,
    messageId: params.messageId,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
  if (hasMessageSentHooks) {
    fireAndForgetHook(
      hookRunner!.runMessageSent(
        toPluginMessageSentEvent(canonical),
        toPluginMessageContext(canonical),
      ),
      `${params.channelId}: message_sent plugin hook failed`,
    );
  }
  if (canEmitInternalHook) {
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "sent",
          params.sessionKey!,
          toInternalMessageSentContext(canonical),
        ),
      ),
      `${params.channelId}: message:sent internal hook failed`,
    );
  }
}
