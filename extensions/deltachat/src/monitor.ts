import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { C } from "@deltachat/jsonrpc-client";
import {
  mergeAllowlist,
  summarizeMapping,
  createTypingCallbacks,
  createReplyPrefixContext,
  recordPendingHistoryEntryIfEnabled,
  clearHistoryEntriesIfEnabled,
  resolveAckReaction,
  removeAckReactionAfterReply,
  shouldAckReaction,
} from "openclaw/plugin-sdk";
import type { CoreConfig } from "./types.js";
import { extractErrorMessage } from "./error-utils.js";
import { PairingQrCodeStorage } from "./pairing-storage.js";
import { resolveDeltaChatReactionLevel } from "./reactions.js";
import { rpcServerManager } from "./rpc-server.js";
import { getDeltaChatRuntime, updateDeltaChatRuntimeState } from "./runtime.js";
import { deliverReplies } from "./send.js";
import { DEFAULT_DATA_DIR } from "./types.js";
import { ensureDataDir, copyAvatarToDataDir } from "./utils.js";

/**
 * Extract the command name from a message text.
 * For example, "!help" returns "help", "/status" returns "status".
 */
function extractCommandName(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  // Check for ! or / prefix
  const match = trimmed.match(/^[/!]([^\s]+)/);
  if (match) {
    return match[1].toLowerCase();
  }

  // If no prefix, return the first word
  const firstWord = trimmed.split(/\s+/)[0];
  return firstWord.toLowerCase();
}

export type MonitorDeltaChatOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  accountId?: string | null;
  onEventListenerRegistered?: () => void;
};

const DEFAULT_MEDIA_MAX_MB = 20;

export async function monitorDeltaChatProvider(opts: MonitorDeltaChatOpts = {}): Promise<void> {
  // Always get the full PluginRuntime for accessing config and channel methods
  const core = getDeltaChatRuntime();
  let cfg = core.config.loadConfig() as CoreConfig;
  if (cfg.channels?.deltachat?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({ module: "deltachat-auto-reply" });
  const formatRuntimeMessage = (...args: Parameters<RuntimeEnv["log"]>) => args.join(" ");
  // Use opts.runtime for logging if provided, otherwise create a fallback
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args) => {
      logger.info(formatRuntimeMessage(...args));
    },
    error: (...args) => {
      logger.error(formatRuntimeMessage(...args));
    },
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const normalizeUserEntry = (raw: string) =>
    raw
      .replace(/^deltachat:/i, "")
      .replace(/^user:/i, "")
      .trim();

  const isDeltaChatEmail = (value: string) => value.includes("@") && value.includes(".");

  const allowlistOnly = cfg.channels?.deltachat?.allowlistOnly === true;
  let allowFrom = cfg.channels?.deltachat?.dm?.allowFrom ?? [];
  let groupsConfig = cfg.channels?.deltachat?.groups;

  // Read from pairing store in addition to config (for approved senders)
  const storeAllowFrom = await core.channel.pairing.readAllowFromStore("deltachat").catch(() => []);
  const effectiveAllowFrom = [...allowFrom, ...storeAllowFrom];

  if (effectiveAllowFrom.length > 0) {
    const entries = effectiveAllowFrom
      .map((entry) => normalizeUserEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");
    if (entries.length > 0) {
      const mapping: string[] = [];
      const unresolved: string[] = [];
      const additions: string[] = [];
      const pending: string[] = [];
      for (const entry of entries) {
        if (isDeltaChatEmail(entry)) {
          additions.push(entry);
          continue;
        }
        pending.push(entry);
      }
      // Delta.Chat uses email addresses as identifiers, so we can't resolve them further
      if (pending.length > 0) {
        for (const entry of pending) {
          unresolved.push(entry);
        }
      }
      const mergedAllowFrom = mergeAllowlist({ existing: effectiveAllowFrom, additions });
      summarizeMapping("deltachat users", mapping, unresolved, runtime);
      // Update effectiveAllowFrom with merged entries
      effectiveAllowFrom.length = 0;
      effectiveAllowFrom.push(...mergedAllowFrom);
    }
  }

  // Get liveness reaction settings (defaults: enabled=true, interval=15 seconds)
  const livenessReactionsEnabled = cfg.channels?.deltachat?.livenessReactionsEnabled ?? true;
  const livenessIntervalSeconds = cfg.channels?.deltachat?.livenessReactionIntervalSeconds ?? 15;

  cfg = {
    ...cfg,
    session: {
      ...cfg.session,
      // Override typing interval with liveness reaction interval for deltachat
      typingIntervalSeconds: livenessIntervalSeconds,
    },
    channels: {
      ...cfg.channels,
      deltachat: {
        ...cfg.channels?.deltachat,
        dm: {
          ...cfg.channels?.deltachat?.dm,
          allowFrom: effectiveAllowFrom,
        },
        ...(groupsConfig ? { groups: groupsConfig } : {}),
      },
    },
  };

  const dataDir = cfg.channels?.deltachat?.dataDir ?? DEFAULT_DATA_DIR;
  const expandedDataDir = ensureDataDir(dataDir);
  const dc = await rpcServerManager.start(expandedDataDir);
  if (!dc) {
    runtime.error?.("Failed to start Delta.Chat RPC server");
    return;
  }

  // Get or create account
  let accounts = await dc.rpc.getAllAccounts();
  let account = accounts[0];

  if (!account) {
    const accountId = await dc.rpc.addAccount();
    account = await dc.rpc.getAccountInfo(accountId);
  }

  // Configure if unconfigured
  if (account.kind === "Unconfigured") {
    const addr = cfg.channels?.deltachat?.addr;
    const mail_pw = cfg.channels?.deltachat?.mail_pw;
    const chatmailQr = cfg.channels?.deltachat?.chatmailQr;

    // Copy OpenClaw avatar to Delta.Chat data directory
    const avatarPath = copyAvatarToDataDir(expandedDataDir);

    if (chatmailQr) {
      const config: Record<string, string> = {
        bot: "1",
        e2ee_enabled: "1",
        displayname: "OpenClaw",
        selfavatar: avatarPath ?? "",
      };
      await dc.rpc.batchSetConfig(account.id, config);
      await dc.rpc.setConfigFromQr(account.id, chatmailQr);
      // After setting the QR code, Delta.Chat creates a random email address
      // We need to configure the account to finalize the setup
      await dc.rpc.configure(account.id);
    } else if (addr && mail_pw) {
      const config: Record<string, string> = {
        addr,
        mail_pw,
        bot: "1",
        e2ee_enabled: "1",
        displayname: "OpenClaw",
        selfavatar: avatarPath ?? "",
      };
      await dc.rpc.batchSetConfig(account.id, config);
      await dc.rpc.configure(account.id);
    } else {
      runtime.error?.("Delta.Chat requires addr/mail_pw or chatmailQr to be configured");
      return;
    }
    // Start IO after configuring a new account (required for QR code generation)
    await dc.rpc.startIo(account.id);
  } else {
    await dc.rpc.startIo(account.id);
  }

  // Generate and store the pairing QR code for later retrieval
  // This allows the pairing command to retrieve the QR code without starting its own RPC server
  // Use chatId: null to generate the "Contact Me" QR code (setup contact QR code)
  try {
    const qrCodeData = await dc.rpc.getChatSecurejoinQrCode(account.id, null);
    if (qrCodeData) {
      runtime.log?.(`Delta.Chat pairing QR code: ${qrCodeData}`);
      PairingQrCodeStorage.storeQrCode(expandedDataDir, qrCodeData);
    } else {
      runtime.error?.(`Failed to generate pairing QR code: no data returned`);
    }
  } catch (err) {
    runtime.error?.(`Failed to generate pairing QR code: ${extractErrorMessage(err)}`);
  }

  const _mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicyRaw = cfg.channels?.deltachat?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const groupPolicy = allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const _replyToMode = opts.replyToMode ?? cfg.channels?.deltachat?.replyToMode ?? "off";
  const dmConfig = cfg.channels?.deltachat?.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const _textLimit = core.channel.text.resolveTextChunkLimit(cfg, "deltachat");
  const mediaMaxMb = opts.mediaMaxMb ?? cfg.channels?.deltachat?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const _mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const _startupMs = Date.now();
  const _startupGraceMs = 0;

  const emitter = dc.getContextEvents(account.id);

  // Track event listeners so we can remove them on provider stop/reload
  // to prevent duplicate handlers from stacking up across hot-reloads.
  const registeredListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];
  function trackListener<T extends (...args: unknown[]) => void>(event: string, handler: T) {
    registeredListeners.push({ event, handler: handler as (...args: unknown[]) => void });
    emitter.on(event, handler as (...args: unknown[]) => void);
  }

  // Create inbound debouncer for Delta.Chat
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "deltachat",
  });

  type DeltachatDebounceEntry = {
    senderEmail: string;
    chatId: number;
    msgId: number;
    text: string;
    isGroup: boolean;
    commandAuthorized: boolean;
    timestamp?: number;
    mediaUrl?: string;
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<DeltachatDebounceEntry>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? String(entry.chatId) : entry.senderEmail;
      return `deltachat:${account.id}:${conversationId}:${entry.senderEmail}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.text.trim()) return false;
      return !core.channel.text.hasControlCommand(entry.text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;

      if (entries.length === 1) {
        await handleInboundMessage(last);
        return;
      }

      // Combine multiple rapid messages
      const combinedText = entries
        .map((e) => e.text)
        .filter(Boolean)
        .join("\n");

      await handleInboundMessage({
        ...last,
        text: combinedText,
      });
    },
    onError: (err: unknown) => {
      runtime.error?.(`deltachat debounce flush failed: ${String(err)}`);
    },
  });

  // Handle incoming messages via IncomingMsg event
  trackListener("IncomingMsg", async ({ chatId, msgId }: { chatId: number; msgId: number }) => {
    const chat = await dc!.rpc.getBasicChatInfo(account.id, chatId);
    const message = await dc!.rpc.getMessage(account.id, msgId);

    // Skip system messages and info messages
    if (message.isInfo || message.systemMessageType !== "Unknown") {
      return;
    }

    // Get sender info
    let senderEmail = "unknown";
    try {
      const contact = await dc.rpc.getContact(account.id, message.fromId);
      senderEmail = contact.address;
    } catch {
      runtime.log?.(`Could not get contact info for message ${msgId}`);
    }

    // Check if this is a direct message or group message
    const isDirect = chat.chatType === C.DC_CHAT_TYPE_SINGLE;
    const isGroup = chat.chatType === C.DC_CHAT_TYPE_GROUP;

    // Security checks
    if (isDirect) {
      if (!dmEnabled) {
        runtime.log?.(`deltachat: dropping message from ${senderEmail} (dm disabled)`);
        return;
      }

      if (dmPolicy === "disabled") {
        runtime.log?.(`deltachat: dropping message from ${senderEmail} (dm policy disabled)`);
        return;
      }

      if (dmPolicy === "pairing" || dmPolicy === "allowlist") {
        const normalizedSender = senderEmail.toLowerCase();
        const allowed = effectiveAllowFrom.some((entry) => {
          const normalizedEntry = String(entry)
            .toLowerCase()
            .replace(/^deltachat:/i, "");
          return normalizedEntry === normalizedSender || normalizedEntry === "*";
        });

        if (!allowed) {
          if (dmPolicy === "pairing") {
            // Create a pairing request for the unapproved sender
            const { code, created } = await core.channel.pairing.upsertPairingRequest({
              channel: "deltachat",
              id: senderEmail,
              meta: {
                sender: senderEmail,
                chatId: String(chatId),
              },
            });

            if (created) {
              runtime.log?.(`deltachat pairing request sender=${senderEmail} code=${code}`);
              // Send pairing code to the sender
              try {
                // Check if RPC server is responsive before sending
                if (!(await rpcServerManager.isResponsive())) {
                  runtime.error?.(
                    `Delta.Chat RPC server not responsive, cannot send pairing code to ${senderEmail}`,
                  );
                  return;
                }
                // Check if this is a contact request chat and accept it if needed
                // Delta.Chat requires contact requests to be accepted before messages can be sent
                if (chat.isContactRequest) {
                  runtime.log?.(`Accepting contact request for chat ${chatId}`);
                  await dc.rpc.acceptChat(account.id, chatId);
                }
                await dc.rpc.miscSendTextMessage(
                  account.id,
                  chatId,
                  core.channel.pairing.buildPairingReply({
                    channel: "deltachat",
                    idLine: `Your Delta.Chat account: ${senderEmail}`,
                    code,
                  }),
                );
                updateDeltaChatRuntimeState({ lastOutboundAt: Date.now() });
              } catch (err) {
                runtime.error?.(
                  `Failed to send pairing code to ${senderEmail} (chatId: ${chatId}, account: ${account.id}): ${extractErrorMessage(err)}`,
                );
              }
            }
          }

          runtime.log?.(
            `deltachat: dropping message from ${senderEmail} (dm not allowed, policy: ${dmPolicy})`,
          );
          return;
        }
      }
    } else if (isGroup) {
      if (groupPolicy === "allowlist") {
        const allowedGroups = groupsConfig ? Object.keys(groupsConfig) : [];
        const hasWildcard = allowedGroups.includes("*");
        const isAllowed = hasWildcard || allowedGroups.includes(String(chatId));

        if (!isAllowed) {
          runtime.log?.(`deltachat: dropping message from group ${chatId} (not in allowlist)`);
          return;
        }
      }
    }

    // Process the message text
    const text = message.text || "";

    // Handle media attachments
    let mediaUrl: string | undefined;
    if (message.file && !message.isSetupmessage) {
      try {
        // Read the file from Delta.Chat blob directory
        const fs = await import("node:fs/promises");
        const buffer = await fs.readFile(message.file);

        // Save the media using the runtime's media utility
        const saved = await core.channel.media.saveMediaBuffer(
          buffer,
          message.fileMime ?? undefined,
          "inbound",
          _mediaMaxBytes,
          message.fileName ?? undefined,
        );

        mediaUrl = saved.path;
        runtime.log?.(
          `[Delta.Chat] Saved inbound media: ${saved.path} (${saved.size} bytes, ${saved.contentType})`,
        );
      } catch (err) {
        runtime.error?.(`[Delta.Chat] Failed to save inbound media: ${extractErrorMessage(err)}`);
      }
    }

    // Build mention regexes for the bot (used for requireMention checks)
    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
    const hasExplicitMention = core.channel.mentions.matchesMentionPatterns(text, mentionRegexes);

    // Check group-specific requireMention setting (keyed by chat ID, not name)
    const groupConfig = groupsConfig?.[String(chatId)] ?? groupsConfig?.["*"];
    const requireMention = groupConfig?.requireMention ?? false;

    // For group messages with requireMention=true, drop messages without explicit mention
    if (isGroup && requireMention && !hasExplicitMention) {
      runtime.log?.(
        `deltachat: dropping message from group ${chatId} (requireMention=true, no mention found)`,
      );
      return;
    }

    // Command detection and gating
    // Calculate permission status for command gating
    const normalizedSender = senderEmail.toLowerCase();
    const dmAllowed =
      dmPolicy === "open" ||
      effectiveAllowFrom.some((entry) => {
        const normalizedEntry = String(entry)
          .toLowerCase()
          .replace(/^deltachat:/i, "");
        return normalizedEntry === normalizedSender || normalizedEntry === "*";
      });

    const allowedGroups = groupsConfig ? Object.keys(groupsConfig) : [];
    const groupAllowed =
      groupPolicy === "open" ||
      allowedGroups.includes(String(chatId)) ||
      allowedGroups.includes("*");

    const hasControlCommandInMessage = core.channel.text.hasControlCommand(text, cfg);
    const commandGate = core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups: cfg.commands?.useAccessGroups !== false,
      authorizers: [
        { configured: effectiveAllowFrom.length > 0, allowed: dmAllowed },
        {
          configured: groupsConfig ? Object.keys(groupsConfig).length > 0 : false,
          allowed: groupAllowed,
        },
      ],
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
    });

    let commandAuthorized = isGroup ? commandGate.authorized : dmAllowed;

    // For group messages with requireMention=true, only allow commands with explicit mention
    if (isGroup && requireMention && hasControlCommandInMessage && !hasExplicitMention) {
      commandAuthorized = false;
      runtime.log?.(
        `deltachat: dropping command from ${senderEmail} in group ${chatId} (requireMention=true, no mention)`,
      );
      return;
    }

    if (isGroup && commandGate.shouldDeny) {
      runtime.log?.(
        `deltachat: dropping message from ${senderEmail} (control command unauthorized)`,
      );
      return;
    }

    // Tool policy resolution for group messages
    if (isGroup && hasControlCommandInMessage) {
      const toolPolicy = groupConfig?.tools ?? "allow"; // Default: allow all tools
      const senderPolicy = groupConfig?.toolsBySender?.[senderEmail];

      // Resolve final tool policy (sender-specific overrides group)
      const resolvedPolicy = senderPolicy ?? toolPolicy;

      // Check if command is allowed
      if (resolvedPolicy === "deny") {
        runtime.log?.(
          `deltachat: dropping command from ${senderEmail} in group ${chatId} (tools=deny)`,
        );
        return;
      }

      if (typeof resolvedPolicy === "object" && resolvedPolicy.deny) {
        const commandName = extractCommandName(text);
        if (resolvedPolicy.deny.includes(commandName)) {
          runtime.log?.(
            `deltachat: dropping command ${commandName} from ${senderEmail} in group ${chatId} (denied)`,
          );
          return;
        }
      }
    }

    if (!text.trim()) {
      return;
    }

    // Enqueue message for debounced processing
    await inboundDebouncer.enqueue({
      senderEmail,
      chatId,
      msgId,
      text,
      isGroup,
      commandAuthorized,
      timestamp: message.timestamp,
      mediaUrl,
    });
  });

  // Signal that event listener is registered
  opts.onEventListenerRegistered?.();

  // Handle actual message processing (called by debouncer)
  async function handleInboundMessage(entry: DeltachatDebounceEntry): Promise<void> {
    const { senderEmail, chatId, msgId, text, isGroup, timestamp, mediaUrl } = entry;

    // Update runtime status
    updateDeltaChatRuntimeState({ lastInboundAt: Date.now() });

    // Build inbound context (following Signal/Telegram patterns)
    const deltaChatTo = isGroup ? `group:${chatId}` : `deltachat:${senderEmail}`;

    // Get chat info for conversation label
    const chat = await dc!.rpc.getBasicChatInfo(account.id, chatId);
    const conversationLabel = isGroup ? chat.name : senderEmail;

    // Format the body with envelope for agent context
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Delta.Chat",
      from: isGroup ? conversationLabel : senderEmail,
      timestamp: timestamp ?? Date.now(),
      body: text,
      chatType: isGroup ? "group" : "direct",
      envelope: envelopeOptions,
    });

    // Build message context
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: text,
      CommandBody: text,
      From: isGroup ? `group:${chatId}` : `deltachat:${senderEmail}`,
      To: deltaChatTo,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: conversationLabel,
      GroupSubject: isGroup ? conversationLabel : undefined,
      SenderName: senderEmail,
      SenderId: senderEmail,
      Provider: "deltachat",
      Surface: "deltachat",
      Timestamp: timestamp ?? Date.now(),
      OriginatingChannel: "deltachat",
      OriginatingTo: deltaChatTo,
      MediaUrl: mediaUrl,
    });

    // Resolve agent route
    const route = core.channel.routing.resolveAgentRoute({
      from: ctxPayload.From,
      to: ctxPayload.To,
      isGroup,
      cfg,
      accountKey: account.id,
      channel: "deltachat",
      metadata: {
        serviceName: "deltachat",
      },
    });

    // Log the incoming message with context
    runtime.log?.(
      `Incoming ${isGroup ? "group" : "DM"} message from ${senderEmail} to ${ctxPayload.To}, route: ${route.agentId || "unresolved"}`,
    );

    // Record inbound session
    const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });

    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !isGroup
        ? {
            sessionKey: route.mainSessionKey,
            channel: "deltachat",
            accountId: account.id,
            to: ctxPayload.To,
          }
        : undefined,
    });

    // Record pending history entry (for group message history)
    if (isGroup) {
      const historyKey = `${account.id}:${chatId}`;
      recordPendingHistoryEntryIfEnabled({
        historyMap: new Map<string, unknown[]>(),
        historyKey,
        ctx: ctxPayload,
        limit: 50,
      });
    }

    // Create typing callbacks with cycling reaction liveness indicator
    // Delta.Chat doesn't support native typing indicators, so we cycle through reactions
    const livenessReactions = ["⏳", "⚙️", "🤔", "💭"];
    let livenessReactionIndex = 0;
    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        // Skip liveness reactions if disabled in config
        if (!livenessReactionsEnabled) {
          return;
        }
        try {
          // Cycle through liveness reactions to show the bot is working
          const reaction = livenessReactions[livenessReactionIndex];
          livenessReactionIndex = (livenessReactionIndex + 1) % livenessReactions.length;
          await dc!.rpc.sendReaction(account.id, msgId, [reaction]);
          runtime.log?.(`Liveness reaction sent: ${reaction}`);
        } catch (err) {
          runtime.error?.(`deltachat liveness reaction failed: ${String(err)}`);
        }
      },
      stop: async () => {
        // Skip cleanup if liveness reactions were disabled
        if (!livenessReactionsEnabled) {
          return;
        }
        try {
          // Clear the liveness reaction when done
          await dc!.rpc.sendReaction(account.id, msgId, []);
          runtime.log?.(`Liveness reaction cleared`);
        } catch (err) {
          runtime.error?.(`deltachat liveness reaction cleanup failed: ${String(err)}`);
        }
      },
      onStartError: (err: unknown) => {
        runtime.error?.(`deltachat typing failure: ${String(err)}`);
      },
    });

    // Create reply prefix context with agent ID from route
    const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

    // Create reply dispatcher with typing support
    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        responsePrefix: prefixContext.responsePrefix,
        responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
        humanDelay: { enabled: false }, // Delta.Chat doesn't need human delay simulation
        deliver: async (payload: { text?: string }) => {
          // Deliver replies to Delta.Chat users
          // The dispatcher passes a single ReplyPayload, not an array
          await deliverReplies({
            replies: [payload],
            target: deltaChatTo,
            accountId: account.id,
            runtime,
            textLimit: 4000, // Delta.Chat's message limit
          });
        },
        onError: (err: unknown, info: { kind: string }) => {
          runtime.error?.(`deltachat ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks.onReplyStart,
      });

    // Mention detection for ack reactions
    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
    const hasExplicitMention = core.channel.mentions.matchesMentionPatterns(text, mentionRegexes);
    const groupConfig = groupsConfig?.[String(chatId)] ?? groupsConfig?.["*"];
    const requireMention = groupConfig?.requireMention ?? false;

    // ACK reactions - send automatic ack reaction if configured
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const ackReaction = resolveAckReaction(cfg, route.agentId);
    const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;

    // Check if we should send an ack reaction
    const shouldSendAckReaction = () => {
      if (!ackReaction) {
        return false;
      }
      // Check reaction level - only send ack reactions if ackEnabled is true
      const reactionLevel = resolveDeltaChatReactionLevel({
        cfg,
      });
      if (!reactionLevel.ackEnabled) {
        return false;
      }

      // For ack reactions, we use the same mention detection as message processing
      const canDetectMention = mentionRegexes.length > 0;
      const effectiveWasMentioned = hasExplicitMention;

      return shouldAckReaction({
        scope: ackReactionScope,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup,
        requireMention: Boolean(requireMention),
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention: false,
      });
    };

    // Send ack reaction if conditions are met
    const shouldSend = shouldSendAckReaction();
    const ackReactionPromise = shouldSend
      ? (async () => {
          try {
            await dc!.rpc.sendReaction(account.id, msgId, [ackReaction]);
            return true;
          } catch (err) {
            runtime.error?.(`deltachat ack reaction failed: ${String(err)}`);
            return false;
          }
        })()
      : null;

    // Dispatch to agent for processing
    const { queuedFinal } = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    // Remove ack reaction after reply is sent (if configured)
    removeAckReactionAfterReply({
      removeAfterReply: removeAckAfterReply,
      ackReactionPromise,
      ackReactionValue: ackReactionPromise ? ackReaction : null,
      remove: async () => {
        try {
          await dc!.rpc.sendReaction(account.id, msgId, []);
        } catch (err) {
          runtime.error?.(`deltachat failed to remove ack reaction: ${String(err)}`);
        }
      },
      onError: (err) => {
        runtime.error?.(`deltachat failed to remove ack reaction: ${String(err)}`);
      },
    });

    if (!queuedFinal) {
      if (isGroup) {
        const historyKey = `${account.id}:${chatId}`;
        clearHistoryEntriesIfEnabled({
          historyMap: new Map<string, unknown[]>(),
          historyKey,
          limit: 50,
        });
      }
      return;
    }

    if (isGroup) {
      const historyKey = `${account.id}:${chatId}`;
      clearHistoryEntriesIfEnabled({
        historyMap: new Map<string, unknown[]>(),
        historyKey,
        limit: 50,
      });
    }
  }

  // Helper function to dispatch inbound message (not in SDK, implemented locally)
  async function dispatchInboundMessage(params: {
    ctx: unknown;
    cfg: CoreConfig;
    dispatcher: unknown;
    replyOptions?: unknown;
  }) {
    const { finalizeInboundContext, dispatchReplyFromConfig } = core.channel.reply;
    const finalized = finalizeInboundContext(params.ctx);
    return await dispatchReplyFromConfig({
      ctx: finalized,
      cfg: params.cfg,
      dispatcher: params.dispatcher,
      replyOptions: params.replyOptions,
    });
  }

  // Handle other events for debugging
  trackListener("MsgsChanged", async ({ chatId, msgId }: { chatId: number; msgId: number }) => {
    runtime.log?.(`Message changed: chat=${chatId}, msg=${msgId}`);
  });

  trackListener("ChatModified", async ({ chatId }: { chatId: number }) => {
    runtime.log?.(`Chat modified: ${chatId}`);
  });

  // Connectivity monitoring events
  // Track last connectivity status to avoid duplicate logs
  let lastConnectivityStatus: number | null = null;
  trackListener("ConnectivityChanged", async () => {
    try {
      const connectivity = await dc!.rpc.getConnectivity(account.id);

      // Only log if status actually changed
      if (connectivity === lastConnectivityStatus) {
        return;
      }

      const statusMap: Record<number, string> = {
        1000: "NOT_CONNECTED",
        2000: "CONNECTING",
        3000: "WORKING",
        4000: "CONNECTED",
      };
      const statusName = statusMap[connectivity] || `UNKNOWN(${connectivity})`;
      runtime.log?.(`[Connectivity] Status changed to: ${statusName} (${connectivity})`);

      lastConnectivityStatus = connectivity;

      // If disconnected, log warning
      if (connectivity === 1000) {
        runtime.error?.(
          `[Connectivity] IMAP connection lost! DeltaChat should attempt reconnection automatically.`,
        );
      }
    } catch (err) {
      runtime.error?.(`[Connectivity] Failed to check connectivity status: ${String(err)}`);
    }
  });

  // Track IMAP/SMTP connection events to avoid duplicate logs
  let lastImapConnectedAt = 0;
  let lastImapIdleAt = 0;
  let lastSmtpConnectedAt = 0;
  const CONNECTION_EVENT_DEBOUNCE_MS = 5000; // 5 seconds

  trackListener("ImapConnected", async () => {
    const now = Date.now();
    if (now - lastImapConnectedAt < CONNECTION_EVENT_DEBOUNCE_MS) {
      return;
    }
    lastImapConnectedAt = now;
    runtime.log?.(`[IMAP] Successfully connected to mail server`);
  });

  trackListener("ImapInboxIdle", async () => {
    const now = Date.now();
    if (now - lastImapIdleAt < CONNECTION_EVENT_DEBOUNCE_MS) {
      return;
    }
    lastImapIdleAt = now;
    runtime.log?.(`[IMAP] Entered IDLE mode on Inbox folder (ready to receive instant messages)`);
  });

  // SMTP outbound monitoring
  trackListener("SmtpConnected", async () => {
    const now = Date.now();
    if (now - lastSmtpConnectedAt < CONNECTION_EVENT_DEBOUNCE_MS) {
      return;
    }
    lastSmtpConnectedAt = now;
    runtime.log?.(`[SMTP] Successfully connected to mail server (outbound)`);
  });

  // Error and warning monitoring
  trackListener("Error", async (event: { msg: string }) => {
    runtime.error?.(`[DeltaChat Error] ${event.msg}`);
  });

  trackListener("Warning", async (event: { msg: string }) => {
    runtime.error?.(`[DeltaChat Warning] ${event.msg}`);
  });

  // Critical event overflow indicator
  trackListener("EventChannelOverflow", async () => {
    runtime.error?.(
      `[Critical] Event channel overflow! DeltaChat is generating events faster than they can be processed. Some events may be lost.`,
    );
  });

  // Message failure monitoring
  trackListener("MsgFailed", async (event: { chatId: number; msgId: number }) => {
    runtime.error?.(
      `[Message Failed] Failed to send message ${event.msgId} in chat ${event.chatId}`,
    );
  });

  // Group removal notification
  trackListener("ErrorSelfNotInGroup", async (event: { msg: string }) => {
    runtime.error?.(`[Group Error] Bot is not in group or was removed: ${event.msg}`);
  });

  runtime.log?.(`Delta.Chat bot started for account ${account.id}`);
  updateDeltaChatRuntimeState({ lastStartAt: Date.now() });

  // Connectivity watchdog - periodically check connectivity and restart IO if needed
  const watchdogIntervalMs =
    cfg.channels?.deltachat?.connectivityWatchdogIntervalMs ?? 5 * 60 * 1000; // Default: 5 minutes
  const watchdogEnabled = cfg.channels?.deltachat?.connectivityWatchdogEnabled ?? true;

  let watchdogTimer: NodeJS.Timeout | null = null;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;

  async function runConnectivityWatchdog() {
    try {
      const connectivity = await dc!.rpc.getConnectivity(account.id);
      const statusMap: Record<number, string> = {
        1000: "NOT_CONNECTED",
        2000: "CONNECTING",
        3000: "WORKING",
        4000: "CONNECTED",
      };
      const statusName = statusMap[connectivity] || `UNKNOWN(${connectivity})`;

      // If not connected or connecting for too long, attempt to restart IO
      if (connectivity === 1000 || (connectivity === 2000 && consecutiveFailures > 0)) {
        consecutiveFailures++;
        runtime.error?.(
          `[Watchdog] Connectivity issue detected: ${statusName} (failure count: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          runtime.error?.(
            `[Watchdog] Max consecutive failures reached. Attempting to restart IO...`,
          );
          try {
            // Stop IO and restart it
            await dc!.rpc.stopIo(account.id);
            runtime.log?.(`[Watchdog] Stopped IO for account ${account.id}`);
            await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
            await dc!.rpc.startIo(account.id);
            runtime.log?.(`[Watchdog] Restarted IO for account ${account.id}`);
            consecutiveFailures = 0; // Reset counter after successful restart
          } catch (err) {
            runtime.error?.(`[Watchdog] Failed to restart IO: ${String(err)}`);
          }
        }
      } else if (connectivity === 3000 || connectivity === 4000) {
        // Connected or working - reset failure counter
        if (consecutiveFailures > 0) {
          runtime.log?.(
            `[Watchdog] Connectivity restored: ${statusName}. Resetting failure counter.`,
          );
          consecutiveFailures = 0;
        }
      }
    } catch (err) {
      runtime.error?.(`[Watchdog] Error checking connectivity: ${String(err)}`);
    }
  }

  if (watchdogEnabled && watchdogIntervalMs > 0) {
    runtime.log?.(
      `[Watchdog] Starting connectivity watchdog (interval: ${watchdogIntervalMs}ms = ${watchdogIntervalMs / 60000} minutes)`,
    );
    // Run initial check after 1 minute
    setTimeout(() => {
      void runConnectivityWatchdog();
    }, 60000);
    // Then run periodically
    watchdogTimer = setInterval(() => {
      void runConnectivityWatchdog();
    }, watchdogIntervalMs);
  }

  // Wait for abort signal
  await new Promise<void>((resolve) => {
    const onAbort = async () => {
      try {
        runtime.log?.("Delta.Chat: stopping provider");
        // Stop watchdog timer
        if (watchdogTimer) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
          runtime.log?.("[Watchdog] Stopped connectivity watchdog");
        }
        // Remove event listeners to prevent duplicates on hot-reload
        for (const { event, handler } of registeredListeners) {
          emitter.off(event, handler);
        }
        registeredListeners.length = 0;
        // Stop IO for this specific account
        await dc.rpc.stopIo(account.id);
        // The RPC server manager will handle shutting down the server
        // when the gateway shuts down
      } finally {
        resolve();
      }
    };
    if (opts.abortSignal?.aborted) {
      void onAbort();
      return;
    }
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
