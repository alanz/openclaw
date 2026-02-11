import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFastShortTimeouts } from "../../test/helpers/fast-short-timeouts.js";
import { EmbeddingRateLimitError } from "./embedding-errors.js";
import { installEmbeddingManagerFixture } from "./embedding-manager.test-harness.js";
import type { MemoryIndexManager } from "./index.js";

const fx = installEmbeddingManagerFixture({
  fixturePrefix: "openclaw-mem-",
  largeTokens: 4000,
  smallTokens: 200,
  createCfg: ({ workspaceDir, indexPath, tokens }) => ({
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath, vector: { enabled: false } },
          chunking: { tokens, overlap: 0 },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  }),
});
const { embedBatch } = fx;

describe("memory embedding batches", () => {
  let manager: MemoryIndexManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
  });

  it("splits large files across multiple embedding batches", async () => {
    const memoryDir = fx.getMemoryDir();
    const managerLarge = fx.getManagerLarge();
    // Keep this small but above the embedding batch byte threshold (8k) so we
    // exercise multi-batch behavior without generating lots of chunks/DB rows.
    const line = "a".repeat(4200);
    const content = [line, line].join("\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-03.md"), content);
    const updates: Array<{ completed: number; total: number; label?: string }> = [];
    await managerLarge.sync({
      progress: (update) => {
        updates.push(update);
      },
    });

    const status = managerLarge.status();
    const totalTexts = embedBatch.mock.calls.reduce(
      (sum: number, call: unknown[]) => sum + ((call[0] as string[] | undefined)?.length ?? 0),
      0,
    );
    expect(totalTexts).toBe(status.chunks);
    expect(embedBatch.mock.calls.length).toBeGreaterThan(1);
    const inputs: string[] = embedBatch.mock.calls.flatMap(
      (call: unknown[]) => (call[0] as string[] | undefined) ?? [],
    );
    expect(inputs.every((text) => Buffer.byteLength(text, "utf8") <= 8000)).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((update) => update.label?.includes("/"))).toBe(true);
    const last = updates[updates.length - 1];
    expect(last?.total).toBeGreaterThan(0);
    expect(last?.completed).toBe(last?.total);
  });

  it("keeps small files in a single embedding batch", async () => {
    const memoryDir = fx.getMemoryDir();
    const managerSmall = fx.getManagerSmall();
    const line = "b".repeat(120);
    const content = Array.from({ length: 4 }, () => line).join("\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-04.md"), content);
    await managerSmall.sync({ reason: "test" });

    expect(embedBatch.mock.calls.length).toBe(1);
  });

  it("retries embeddings on transient rate limit and 5xx errors", async () => {
    const memoryDir = fx.getMemoryDir();
    const managerSmall = fx.getManagerSmall();
    const line = "d".repeat(120);
    const content = Array.from({ length: 4 }, () => line).join("\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-06.md"), content);

    const transientErrors = [
      "openai embeddings failed: 429 rate limit",
      "openai embeddings failed: 502 Bad Gateway (cloudflare)",
    ];
    let calls = 0;
    embedBatch.mockImplementation(async (texts: string[]) => {
      calls += 1;
      const transient = transientErrors[calls - 1];
      if (transient) {
        throw new Error(transient);
      }
      return texts.map(() => [0, 1, 0]);
    });

    const restoreFastTimeouts = useFastShortTimeouts();
    try {
      await managerSmall.sync({ reason: "test" });
    } finally {
      restoreFastTimeouts();
    }

    expect(calls).toBe(3);
  }, 10000);

  it("retries embeddings on too-many-tokens-per-day rate limits", async () => {
    const memoryDir = fx.getMemoryDir();
    const managerSmall = fx.getManagerSmall();
    const line = "e".repeat(120);
    const content = Array.from({ length: 4 }, () => line).join("\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-08.md"), content);

    let calls = 0;
    embedBatch.mockImplementation(async (texts: string[]) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("AWS Bedrock embeddings failed: Too many tokens per day");
      }
      return texts.map(() => [0, 1, 0]);
    });

    const restoreFastTimeouts = useFastShortTimeouts();
    try {
      await managerSmall.sync({ reason: "test" });
    } finally {
      restoreFastTimeouts();
    }

    expect(calls).toBe(2);
  }, 10000);

  it("skips empty chunks so embeddings input stays valid", async () => {
    const memoryDir = fx.getMemoryDir();
    const managerSmall = fx.getManagerSmall();
    await fs.writeFile(path.join(memoryDir, "2026-01-07.md"), "\n\n\n");
    await managerSmall.sync({ reason: "test" });

    const inputs = embedBatch.mock.calls.flatMap((call: unknown[]) => (call[0] as string[]) ?? []);
    expect(inputs).not.toContain("");
  });

  it("retries on RPM EmbeddingRateLimitError (like existing 429 test)", async () => {
    const memoryDir = fx.getMemoryDir();
    const workspaceDir = path.dirname(memoryDir);
    const line = "f".repeat(120);
    const content = Array.from({ length: 4 }, () => line).join("\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-09.md"), content);

    let calls = 0;
    embedBatch.mockImplementation(async (texts: string[]) => {
      calls += 1;
      if (calls < 3) {
        throw new EmbeddingRateLimitError(
          "gemini embeddings failed: 429 rate limit",
          "rpm",
          10_000,
        );
      }
      return texts.map(() => [0, 1, 0]);
    });

    const realSetTimeout = setTimeout;
    const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const delay = typeof timeout === "number" ? timeout : 0;
      if (delay > 0 && delay <= 15_000) {
        return realSetTimeout(handler, 0, ...args);
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout);

    const indexPath = path.join(path.dirname(workspaceDir), "index-rpm-test.sqlite");
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai" as const,
            model: "mock-embed",
            store: { path: indexPath },
            chunking: { tokens: 200, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as MemoryIndexManager;
    try {
      await manager.sync({ force: true });
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(calls).toBe(3);
  }, 10000);

  it("does NOT retry on RPD EmbeddingRateLimitError (daily quota exhausted)", async () => {
    const memoryDir = fx.getMemoryDir();
    const workspaceDir = path.dirname(memoryDir);
    const line = "g".repeat(120);
    const content = Array.from({ length: 4 }, () => line).join("\n");
    await fs.writeFile(path.join(memoryDir, "2026-01-10.md"), content);

    let calls = 0;
    embedBatch.mockImplementation(async () => {
      calls += 1;
      throw new EmbeddingRateLimitError(
        "gemini embeddings failed: 429 daily quota exhausted",
        "rpd",
        31_000,
      );
    });

    const indexPath = path.join(path.dirname(workspaceDir), "index-rpd-test.sqlite");
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai" as const,
            model: "mock-embed",
            store: { path: indexPath },
            chunking: { tokens: 200, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as MemoryIndexManager;

    // sync should fail because RPD errors are not retried
    await expect(manager.sync({ force: true })).rejects.toThrow("daily quota exhausted");

    // Should have only been called once (no retries)
    expect(calls).toBe(1);
  }, 10000);
});
