process.env.NO_COLOR = "1";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  channelsGroupsListCommand,
  channelsGroupsAddCommand,
  channelsGroupsRemoveCommand,
  channelsGroupsUpdateCommand,
  channelsGroupsShowCommand,
} from "./groups.js";

const logs: string[] = [];
const errors: string[] = [];

let mockConfig: OpenClawConfig = { channels: {} };
let writtenConfig: OpenClawConfig | null = null;

vi.mock("./shared.js", () => ({
  requireValidConfig: vi.fn(async () => mockConfig),
  channelLabel: vi.fn((channel: string) => channel),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...original,
    loadConfig: vi.fn(() => mockConfig),
    writeConfigFile: vi.fn(async (cfg: OpenClawConfig) => {
      writtenConfig = cfg;
    }),
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn((channelId: string) => {
    if (["deltachat", "telegram", "slack"].includes(channelId)) {
      return { meta: { label: channelId }, id: channelId };
    }
    return null;
  }),
}));

const runtime = {
  log: (value: string) => logs.push(value),
  error: (value: string) => errors.push(value),
  exit: (code: number) => {
    throw new Error(`exit:${code}`);
  },
};

function resetOutput() {
  logs.length = 0;
  errors.length = 0;
  writtenConfig = null;
}

function setupDeltaChatWithGroups(groups: Record<string, unknown>) {
  mockConfig = {
    channels: {
      deltachat: {
        enabled: true,
        groups,
      },
    },
  };
}

describe("channelsGroupsListCommand", () => {
  beforeEach(() => {
    resetOutput();
    vi.clearAllMocks();
  });

  it("lists groups from deltachat config", async () => {
    setupDeltaChatWithGroups({
      "16": { users: ["*"], requireMention: false },
      "42": { users: ["user@example.com"], requireMention: true, tools: "allow" },
    });

    await channelsGroupsListCommand({ channel: "deltachat" }, runtime);

    const output = logs.join("\n");
    expect(output).toContain("16");
    expect(output).toContain("42");
  });

  it("shows message when no groups configured", async () => {
    setupDeltaChatWithGroups({});

    await channelsGroupsListCommand({ channel: "deltachat" }, runtime);

    const output = logs.join("\n");
    expect(output).toContain("No groups configured");
  });

  it("outputs JSON when requested", async () => {
    setupDeltaChatWithGroups({
      "16": { users: ["*"] },
    });

    await channelsGroupsListCommand({ channel: "deltachat", json: true }, runtime);

    const output = logs[0];
    const parsed = JSON.parse(output);
    expect(parsed.channel).toBe("deltachat");
    expect(parsed.groups).toEqual(["16"]);
  });

  it("throws error for unsupported channel", async () => {
    mockConfig = { channels: {} };

    await expect(channelsGroupsListCommand({ channel: "unknown" }, runtime)).rejects.toThrow(
      "Unknown channel",
    );
  });
});

describe("channelsGroupsAddCommand", () => {
  beforeEach(() => {
    resetOutput();
    vi.clearAllMocks();
  });

  it("adds a new group to deltachat config", async () => {
    setupDeltaChatWithGroups({});

    await channelsGroupsAddCommand(
      {
        channel: "deltachat",
        group: "16",
        users: "*",
        requireMention: true,
      },
      runtime,
    );

    expect(writtenConfig?.channels?.deltachat?.groups).toEqual({
      "16": {
        users: ["*"],
        requireMention: true,
      },
    });
    expect(logs.join("\n")).toContain("Added group 16");
  });

  it("adds a group with multiple users", async () => {
    setupDeltaChatWithGroups({});

    await channelsGroupsAddCommand(
      {
        channel: "deltachat",
        group: "42",
        users: "user1@example.com,user2@example.com",
      },
      runtime,
    );

    expect(writtenConfig?.channels?.deltachat?.groups?.["42"]).toEqual({
      users: ["user1@example.com", "user2@example.com"],
    });
  });

  it("adds a group with tool policy", async () => {
    setupDeltaChatWithGroups({});

    await channelsGroupsAddCommand(
      {
        channel: "deltachat",
        group: "16",
        tools: "deny",
      },
      runtime,
    );

    expect(writtenConfig?.channels?.deltachat?.groups?.["16"]).toEqual({
      tools: "deny",
    });
  });

  it("adds a group with complex tool policy", async () => {
    setupDeltaChatWithGroups({});

    await channelsGroupsAddCommand(
      {
        channel: "deltachat",
        group: "16",
        tools: '{"allow":["tool1","tool2"]}',
      },
      runtime,
    );

    expect(writtenConfig?.channels?.deltachat?.groups?.["16"]).toEqual({
      tools: { allow: ["tool1", "tool2"] },
    });
  });

  it("throws error if group already exists", async () => {
    setupDeltaChatWithGroups({
      "16": { users: ["*"] },
    });

    await expect(
      channelsGroupsAddCommand(
        {
          channel: "deltachat",
          group: "16",
        },
        runtime,
      ),
    ).rejects.toThrow("already exists");
  });

  it("throws error if group ID is empty", async () => {
    setupDeltaChatWithGroups({});

    await expect(
      channelsGroupsAddCommand(
        {
          channel: "deltachat",
          group: "",
        },
        runtime,
      ),
    ).rejects.toThrow("required");
  });

  it("works with telegram channel", async () => {
    mockConfig = {
      channels: {
        telegram: {
          enabled: true,
          groups: {},
        },
      },
    };

    await channelsGroupsAddCommand(
      {
        channel: "telegram",
        group: "-100123456789",
        users: "*",
      },
      runtime,
    );

    expect(writtenConfig?.channels?.telegram?.groups).toEqual({
      "-100123456789": {
        users: ["*"],
      },
    });
  });

  it("works with slack channel", async () => {
    mockConfig = {
      channels: {
        slack: {
          enabled: true,
          channels: {},
        },
      },
    };

    await channelsGroupsAddCommand(
      {
        channel: "slack",
        group: "C1234567890",
        users: "U1234,U5678",
      },
      runtime,
    );

    expect(writtenConfig?.channels?.slack?.channels).toEqual({
      C1234567890: {
        users: ["U1234", "U5678"],
      },
    });
  });
});

describe("channelsGroupsRemoveCommand", () => {
  beforeEach(() => {
    resetOutput();
    vi.clearAllMocks();
  });

  it("removes a group from deltachat config", async () => {
    setupDeltaChatWithGroups({
      "16": { users: ["*"] },
      "42": { users: ["user@example.com"] },
    });

    await channelsGroupsRemoveCommand(
      {
        channel: "deltachat",
        group: "16",
      },
      runtime,
    );

    expect(writtenConfig?.channels?.deltachat?.groups).toEqual({
      "42": { users: ["user@example.com"] },
    });
    expect(logs.join("\n")).toContain("Removed group 16");
  });

  it("throws error if group not found", async () => {
    setupDeltaChatWithGroups({
      "42": { users: ["*"] },
    });

    await expect(
      channelsGroupsRemoveCommand(
        {
          channel: "deltachat",
          group: "16",
        },
        runtime,
      ),
    ).rejects.toThrow("not found");
  });

  it("throws error if group ID is empty", async () => {
    setupDeltaChatWithGroups({});

    await expect(
      channelsGroupsRemoveCommand(
        {
          channel: "deltachat",
          group: "",
        },
        runtime,
      ),
    ).rejects.toThrow("required");
  });
});

describe("channelsGroupsUpdateCommand", () => {
  beforeEach(() => {
    resetOutput();
    vi.clearAllMocks();
  });

  it("updates group users", async () => {
    setupDeltaChatWithGroups({
      "16": { users: ["*"], requireMention: false },
    });

    await channelsGroupsUpdateCommand(
      {
        channel: "deltachat",
        group: "16",
        users: "user1@example.com,user2@example.com",
      },
      runtime,
    );

    expect(writtenConfig?.channels?.deltachat?.groups?.["16"]).toEqual({
      users: ["user1@example.com", "user2@example.com"],
      requireMention: false,
    });
    expect(logs.join("\n")).toContain("Updated group 16");
  });

  it("updates requireMention setting", async () => {
    setupDeltaChatWithGroups({
      "16": { users: ["*"], requireMention: false },
    });

    await channelsGroupsUpdateCommand(
      {
        channel: "deltachat",
        group: "16",
        requireMention: true,
      },
      runtime,
    );

    expect(writtenConfig?.channels?.deltachat?.groups?.["16"]).toEqual({
      users: ["*"],
      requireMention: true,
    });
  });

  it("updates tool policy", async () => {
    setupDeltaChatWithGroups({
      "16": { users: ["*"], tools: "allow" },
    });

    await channelsGroupsUpdateCommand(
      {
        channel: "deltachat",
        group: "16",
        tools: "deny",
      },
      runtime,
    );

    expect(writtenConfig?.channels?.deltachat?.groups?.["16"]).toEqual({
      users: ["*"],
      tools: "deny",
    });
  });

  it("updates multiple fields at once", async () => {
    setupDeltaChatWithGroups({
      "16": { users: ["*"], requireMention: false, tools: "allow" },
    });

    await channelsGroupsUpdateCommand(
      {
        channel: "deltachat",
        group: "16",
        users: "user@example.com",
        requireMention: true,
        tools: "deny",
      },
      runtime,
    );

    expect(writtenConfig?.channels?.deltachat?.groups?.["16"]).toEqual({
      users: ["user@example.com"],
      requireMention: true,
      tools: "deny",
    });
  });

  it("throws error if group not found", async () => {
    setupDeltaChatWithGroups({});

    await expect(
      channelsGroupsUpdateCommand(
        {
          channel: "deltachat",
          group: "16",
          users: "*",
        },
        runtime,
      ),
    ).rejects.toThrow("not found");
  });
});

describe("channelsGroupsShowCommand", () => {
  beforeEach(() => {
    resetOutput();
    vi.clearAllMocks();
  });

  it("shows group details", async () => {
    setupDeltaChatWithGroups({
      "16": {
        users: ["user1@example.com", "user2@example.com"],
        requireMention: true,
        tools: "allow",
        name: "Test Group",
      },
    });

    await channelsGroupsShowCommand(
      {
        channel: "deltachat",
        group: "16",
      },
      runtime,
    );

    const output = logs.join("\n");
    expect(output).toContain("16");
    expect(output).toContain("user1@example.com");
    expect(output).toContain("user2@example.com");
    expect(output).toContain("yes");
    expect(output).toContain("allow");
    expect(output).toContain("Test Group");
  });

  it("outputs JSON when requested", async () => {
    setupDeltaChatWithGroups({
      "16": { users: ["*"], requireMention: false },
    });

    await channelsGroupsShowCommand(
      {
        channel: "deltachat",
        group: "16",
        json: true,
      },
      runtime,
    );

    const output = logs[0];
    const parsed = JSON.parse(output);
    expect(parsed.groupId).toBe("16");
    expect(parsed.config.users).toEqual(["*"]);
    expect(parsed.config.requireMention).toBe(false);
  });

  it("shows toolsBySender if configured", async () => {
    setupDeltaChatWithGroups({
      "16": {
        users: ["*"],
        requireMention: false,
        toolsBySender: {
          "user1@example.com": "deny",
          "user2@example.com": { allow: ["tool1"] },
        },
      },
    });

    await channelsGroupsShowCommand(
      {
        channel: "deltachat",
        group: "16",
      },
      runtime,
    );

    const output = logs.join("\n");
    expect(output).toContain("Per-sender tool policies");
    expect(output).toContain("user1@example.com");
    expect(output).toContain("user2@example.com");
  });

  it("throws error if group not found", async () => {
    setupDeltaChatWithGroups({});

    await expect(
      channelsGroupsShowCommand(
        {
          channel: "deltachat",
          group: "16",
        },
        runtime,
      ),
    ).rejects.toThrow("not found");
  });
});
