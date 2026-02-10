import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const tool = {
      name: "boom",
      label: "Boom",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call1", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("returns success for identical-content edit errors instead of error", async () => {
    const tool = {
      name: "edit",
      label: "Edit",
      description: "edit files",
      parameters: {},
      execute: async () => {
        throw new Error(
          "No changes made to /tmp/HEARTBEAT.md. The replacement produced identical content.",
        );
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-noop", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "ok",
      tool: "edit",
      message: "Content already matches, no changes needed.",
    });
  });

  it("normalizes exec tool aliases in error results", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call2", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });
});
