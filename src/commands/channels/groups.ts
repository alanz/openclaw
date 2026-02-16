import type { RuntimeEnv } from "../../runtime.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { writeConfigFile, type OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { renderTable } from "../../terminal/table.js";
import { theme } from "../../terminal/theme.js";
import { requireValidConfig, channelLabel } from "./shared.js";

export type ChannelsGroupsListOptions = {
  channel?: string;
  account?: string;
  json?: boolean;
};

export type ChannelsGroupsAddOptions = {
  channel?: string;
  account?: string;
  group: string;
  users?: string;
  requireMention?: boolean;
  tools?: string;
};

export type ChannelsGroupsRemoveOptions = {
  channel?: string;
  account?: string;
  group: string;
};

export type ChannelsGroupsUpdateOptions = {
  channel?: string;
  account?: string;
  group: string;
  users?: string;
  requireMention?: boolean;
  tools?: string;
};

export type ChannelsGroupsShowOptions = {
  channel?: string;
  account?: string;
  group: string;
  json?: boolean;
};

type GroupConfig = {
  users?: string[];
  requireMention?: boolean;
  tools?: string | { allow?: string[]; deny?: string[] };
  toolsBySender?: Record<string, string | { allow?: string[]; deny?: string[] }>;
  name?: string;
};

type ChannelWithGroups = "deltachat" | "telegram" | "slack";

function supportsGroups(channelId: string): channelId is ChannelWithGroups {
  return ["deltachat", "telegram", "slack"].includes(channelId);
}

function parseUsersList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value
    .split(/[,;\n]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseToolPolicy(
  value: string | undefined,
): string | { allow?: string[]; deny?: string[] } | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  if (value === "allow" || value === "deny") {
    return value;
  }
  // Try to parse as JSON for complex policy
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (Array.isArray(parsed.allow) || Array.isArray(parsed.deny))
    ) {
      return parsed;
    }
  } catch {
    // Fall through to error
  }
  throw new Error(
    'tools must be "allow", "deny", or JSON like {"allow":["tool1"],"deny":["tool2"]}',
  );
}

function getGroupsFromConfig(
  cfg: OpenClawConfig,
  channelId: ChannelWithGroups,
  accountId: string,
): Record<string, GroupConfig> {
  if (channelId === "deltachat") {
    const channel = cfg.channels?.deltachat;
    if (accountId !== DEFAULT_ACCOUNT_ID && channel?.accounts?.[accountId]) {
      return (channel.accounts[accountId] as { groups?: Record<string, GroupConfig> }).groups ?? {};
    }
    return channel?.groups ?? {};
  }
  if (channelId === "telegram") {
    const channel = cfg.channels?.telegram;
    if (accountId !== DEFAULT_ACCOUNT_ID && channel?.accounts?.[accountId]) {
      return (channel.accounts[accountId] as { groups?: Record<string, GroupConfig> }).groups ?? {};
    }
    return channel?.groups ?? {};
  }
  if (channelId === "slack") {
    const channel = cfg.channels?.slack;
    if (accountId !== DEFAULT_ACCOUNT_ID && channel?.accounts?.[accountId]) {
      return (
        (channel.accounts[accountId] as { channels?: Record<string, GroupConfig> }).channels ?? {}
      );
    }
    return channel?.channels ?? {};
  }
  return {};
}

function setGroupsInConfig(
  cfg: OpenClawConfig,
  channelId: ChannelWithGroups,
  accountId: string,
  groups: Record<string, GroupConfig>,
): OpenClawConfig {
  const nextConfig = JSON.parse(JSON.stringify(cfg)) as OpenClawConfig;

  if (channelId === "deltachat") {
    if (!nextConfig.channels) {
      nextConfig.channels = {};
    }
    if (!nextConfig.channels.deltachat) {
      nextConfig.channels.deltachat = { enabled: true };
    }
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      if (!nextConfig.channels.deltachat.accounts) {
        nextConfig.channels.deltachat.accounts = {};
      }
      if (!nextConfig.channels.deltachat.accounts[accountId]) {
        nextConfig.channels.deltachat.accounts[accountId] = { enabled: true };
      }
      (
        nextConfig.channels.deltachat.accounts[accountId] as { groups: Record<string, GroupConfig> }
      ).groups = groups;
    } else {
      nextConfig.channels.deltachat.groups = groups;
    }
  } else if (channelId === "telegram") {
    if (!nextConfig.channels) {
      nextConfig.channels = {};
    }
    if (!nextConfig.channels.telegram) {
      nextConfig.channels.telegram = { enabled: true };
    }
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      if (!nextConfig.channels.telegram.accounts) {
        nextConfig.channels.telegram.accounts = {};
      }
      if (!nextConfig.channels.telegram.accounts[accountId]) {
        nextConfig.channels.telegram.accounts[accountId] = { enabled: true };
      }
      (
        nextConfig.channels.telegram.accounts[accountId] as { groups: Record<string, GroupConfig> }
      ).groups = groups;
    } else {
      nextConfig.channels.telegram.groups = groups;
    }
  } else if (channelId === "slack") {
    if (!nextConfig.channels) {
      nextConfig.channels = {};
    }
    if (!nextConfig.channels.slack) {
      nextConfig.channels.slack = { enabled: true };
    }
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      if (!nextConfig.channels.slack.accounts) {
        nextConfig.channels.slack.accounts = {};
      }
      if (!nextConfig.channels.slack.accounts[accountId]) {
        nextConfig.channels.slack.accounts[accountId] = { enabled: true };
      }
      (
        nextConfig.channels.slack.accounts[accountId] as { channels: Record<string, GroupConfig> }
      ).channels = groups;
    } else {
      nextConfig.channels.slack.channels = groups;
    }
  }

  return nextConfig;
}

export async function channelsGroupsListCommand(
  opts: ChannelsGroupsListOptions,
  runtime: RuntimeEnv,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const channelId = opts.channel ?? "deltachat";
  const accountId = opts.account ?? DEFAULT_ACCOUNT_ID;

  const plugin = getChannelPlugin(channelId);
  if (!plugin) {
    throw new Error(`Unknown channel: ${channelId}`);
  }

  if (!supportsGroups(channelId)) {
    throw new Error(`Channel ${channelLabel(channelId)} does not support group management`);
  }

  const groups = getGroupsFromConfig(cfg, channelId, accountId);
  const groupIds = Object.keys(groups).filter((key) => key !== "*");

  if (opts.json) {
    runtime.log(JSON.stringify({ channel: channelId, accountId, groups: groupIds }, null, 2));
    return;
  }

  if (groupIds.length === 0) {
    runtime.log(theme.muted(`No groups configured for ${channelLabel(channelId)}.`));
    runtime.log(
      `\nAdd a group with: ${theme.command(`openclaw channels groups add --channel ${channelId} --group <id>`)}`,
    );
    return;
  }

  runtime.log(
    `${theme.heading(`${channelLabel(channelId)} groups`)} ${theme.muted(`(${groupIds.length})`)}`,
  );

  const rows = groupIds.map((groupId) => {
    const config = groups[groupId];
    const users = config?.users?.join(", ") ?? "";
    const requireMention = config?.requireMention ?? false;
    const tools =
      typeof config?.tools === "string"
        ? config.tools
        : config?.tools
          ? JSON.stringify(config.tools)
          : "allow";
    return {
      Group: groupId,
      Users: users || "*",
      Mention: requireMention ? "yes" : "no",
      Tools: tools,
    };
  });

  const tableWidth = Math.max(80, (process.stdout.columns ?? 120) - 1);
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Group", header: "Group ID", minWidth: 10, flex: true },
        { key: "Users", header: "Allowed Users", minWidth: 15, flex: true },
        { key: "Mention", header: "@Mention", minWidth: 8 },
        { key: "Tools", header: "Tools", minWidth: 8 },
      ],
      rows,
    }).trimEnd(),
  );
}

export async function channelsGroupsAddCommand(
  opts: ChannelsGroupsAddOptions,
  runtime: RuntimeEnv,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const channelId = opts.channel ?? "deltachat";
  const accountId = opts.account ?? DEFAULT_ACCOUNT_ID;
  const groupId = opts.group.trim();

  if (!groupId) {
    throw new Error("--group <id> is required");
  }

  const plugin = getChannelPlugin(channelId);
  if (!plugin) {
    throw new Error(`Unknown channel: ${channelId}`);
  }

  if (!supportsGroups(channelId)) {
    throw new Error(`Channel ${channelLabel(channelId)} does not support group management`);
  }

  const groups = getGroupsFromConfig(cfg, channelId, accountId);

  if (groups[groupId]) {
    throw new Error(
      `Group ${groupId} already exists. Use ${theme.command("update")} to modify it.`,
    );
  }

  const newGroup: GroupConfig = {};

  const users = parseUsersList(opts.users);
  if (users !== undefined) {
    newGroup.users = users;
  }

  if (opts.requireMention !== undefined) {
    newGroup.requireMention = opts.requireMention;
  }

  const tools = parseToolPolicy(opts.tools);
  if (tools !== undefined) {
    newGroup.tools = tools;
  }

  groups[groupId] = newGroup;

  const nextConfig = setGroupsInConfig(cfg, channelId, accountId, groups);
  await writeConfigFile(nextConfig);

  runtime.log(
    theme.success(`Added group ${theme.command(groupId)} to ${channelLabel(channelId)} allowlist.`),
  );
  runtime.log(
    theme.muted(
      `Restart the gateway for changes to take effect: ${theme.command("openclaw daemon restart")}`,
    ),
  );
}

export async function channelsGroupsRemoveCommand(
  opts: ChannelsGroupsRemoveOptions,
  runtime: RuntimeEnv,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const channelId = opts.channel ?? "deltachat";
  const accountId = opts.account ?? DEFAULT_ACCOUNT_ID;
  const groupId = opts.group.trim();

  if (!groupId) {
    throw new Error("--group <id> is required");
  }

  const plugin = getChannelPlugin(channelId);
  if (!plugin) {
    throw new Error(`Unknown channel: ${channelId}`);
  }

  if (!supportsGroups(channelId)) {
    throw new Error(`Channel ${channelLabel(channelId)} does not support group management`);
  }

  const groups = getGroupsFromConfig(cfg, channelId, accountId);

  if (!groups[groupId]) {
    throw new Error(`Group ${groupId} not found in ${channelLabel(channelId)} allowlist.`);
  }

  delete groups[groupId];

  const nextConfig = setGroupsInConfig(cfg, channelId, accountId, groups);
  await writeConfigFile(nextConfig);

  runtime.log(
    theme.success(
      `Removed group ${theme.command(groupId)} from ${channelLabel(channelId)} allowlist.`,
    ),
  );
  runtime.log(
    theme.muted(
      `Restart the gateway for changes to take effect: ${theme.command("openclaw daemon restart")}`,
    ),
  );
}

export async function channelsGroupsUpdateCommand(
  opts: ChannelsGroupsUpdateOptions,
  runtime: RuntimeEnv,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const channelId = opts.channel ?? "deltachat";
  const accountId = opts.account ?? DEFAULT_ACCOUNT_ID;
  const groupId = opts.group.trim();

  if (!groupId) {
    throw new Error("--group <id> is required");
  }

  const plugin = getChannelPlugin(channelId);
  if (!plugin) {
    throw new Error(`Unknown channel: ${channelId}`);
  }

  if (!supportsGroups(channelId)) {
    throw new Error(`Channel ${channelLabel(channelId)} does not support group management`);
  }

  const groups = getGroupsFromConfig(cfg, channelId, accountId);

  if (!groups[groupId]) {
    throw new Error(`Group ${groupId} not found. Use ${theme.command("add")} to create it first.`);
  }

  const existingGroup = groups[groupId];

  const users = parseUsersList(opts.users);
  if (users !== undefined) {
    existingGroup.users = users;
  }

  if (opts.requireMention !== undefined) {
    existingGroup.requireMention = opts.requireMention;
  }

  const tools = parseToolPolicy(opts.tools);
  if (tools !== undefined) {
    existingGroup.tools = tools;
  }

  groups[groupId] = existingGroup;

  const nextConfig = setGroupsInConfig(cfg, channelId, accountId, groups);
  await writeConfigFile(nextConfig);

  runtime.log(
    theme.success(`Updated group ${theme.command(groupId)} in ${channelLabel(channelId)}.`),
  );
  runtime.log(
    theme.muted(
      `Restart the gateway for changes to take effect: ${theme.command("openclaw daemon restart")}`,
    ),
  );
}

export async function channelsGroupsShowCommand(
  opts: ChannelsGroupsShowOptions,
  runtime: RuntimeEnv,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const channelId = opts.channel ?? "deltachat";
  const accountId = opts.account ?? DEFAULT_ACCOUNT_ID;
  const groupId = opts.group.trim();

  if (!groupId) {
    throw new Error("--group <id> is required");
  }

  const plugin = getChannelPlugin(channelId);
  if (!plugin) {
    throw new Error(`Unknown channel: ${channelId}`);
  }

  if (!supportsGroups(channelId)) {
    throw new Error(`Channel ${channelLabel(channelId)} does not support group management`);
  }

  const groups = getGroupsFromConfig(cfg, channelId, accountId);
  const group = groups[groupId];

  if (!group) {
    throw new Error(`Group ${groupId} not found in ${channelLabel(channelId)} allowlist.`);
  }

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          channel: channelId,
          accountId,
          groupId,
          config: group,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`${theme.heading(`${channelLabel(channelId)} group`)} ${theme.command(groupId)}`);
  runtime.log("");
  runtime.log(`  ${theme.muted("Allowed users:")} ${group.users?.join(", ") ?? "*"}`);
  runtime.log(`  ${theme.muted("Require @mention:")} ${group.requireMention ? "yes" : "no"}`);
  runtime.log(
    `  ${theme.muted("Tools policy:")} ${typeof group.tools === "string" ? group.tools : group.tools ? JSON.stringify(group.tools) : "allow"}`,
  );
  if (group.name) {
    runtime.log(`  ${theme.muted("Name:")} ${group.name}`);
  }
  if (group.toolsBySender && Object.keys(group.toolsBySender).length > 0) {
    runtime.log(`  ${theme.muted("Per-sender tool policies:")}`);
    for (const [sender, policy] of Object.entries(group.toolsBySender)) {
      const policyStr = typeof policy === "string" ? policy : JSON.stringify(policy);
      runtime.log(`    ${sender}: ${policyStr}`);
    }
  }
}
