import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

// Mock chokidar to avoid native fsevents in tests
vi.mock("chokidar", () => ({
  default: {
    watch: () => ({ on: () => {}, close: async () => {} }),
  },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));

// Mock sqlite-vec (not needed for chunking tests)
vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

// Mock embeddings with simple test implementation
vi.mock("./embeddings.js", () => {
  const embedText = (text: string) => {
    // Simple embedding based on text content
    const lower = text.toLowerCase();
    const codeScore = (lower.split("code").length - 1) * 0.5;
    const orgScore = (lower.split("org").length - 1) * 0.3;
    const headingScore = (lower.split("heading").length - 1) * 0.4;
    return [codeScore, orgScore, headingScore];
  };
  return {
    createEmbeddingProvider: async (options: { model?: string }) => ({
      requestedProvider: "local",
      provider: {
        id: "mock",
        model: options.model ?? "mock-embed",
        embedQuery: async (text: string) => embedText(text),
        embedBatch: async (texts: string[]) => texts.map(embedText),
      },
    }),
  };
});

describe("MemoryIndexManager org-mode chunking", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-org-test-"));
    workspaceDir = tmpDir;
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("uses org-aware chunking for .org files", async () => {
    const orgContent = `* Research Notes
:PROPERTIES:
:ID: test-123
:END:

This is some content about code examples.

** Code Example

#+BEGIN_SRC python
def example():
    # This code block should not be split
    return "hello"
#+END_SRC

** More Content

Additional content here.`;

    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    const orgFile = path.join(memoryDir, "notes.org");
    await fs.writeFile(orgFile, orgContent);

    const result = await getMemorySearchManager({
      cfg: {
        agents: {
          defaults: {
            workspace: workspaceDir,
            memorySearch: {
              provider: "local",
              model: "mock-embed",
              store: { path: path.join(tmpDir, "memory.db"), vector: { enabled: false } },
            },
          },
        },
      },
      agentId: "main",
    });

    expect(result.manager).not.toBeNull();
    manager = result.manager as MemoryIndexManager;

    await manager.sync({ force: true });

    const results = await manager.search("code example", { maxResults: 5 });

    // Should find the content
    expect(results.length).toBeGreaterThan(0);

    // Check that code block was not split
    const codeChunk = results.find((r) => r.snippet.includes("#+BEGIN_SRC"));
    if (codeChunk) {
      // If we found a chunk with BEGIN_SRC, it should also have END_SRC
      expect(codeChunk.snippet).toContain("#+END_SRC");
    }
  });

  it("preserves heading context in org file chunks", async () => {
    const orgContent = `* Parent Section

** Child Heading Section
*** Deep Section Heading

Content in deep section with nested org mode headings.`;

    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    const orgFile = path.join(memoryDir, "hierarchy.org");
    await fs.writeFile(orgFile, orgContent);

    const result = await getMemorySearchManager({
      cfg: {
        agents: {
          defaults: {
            workspace: workspaceDir,
            memorySearch: {
              provider: "local",
              model: "mock-embed",
              store: { path: path.join(tmpDir, "memory.db"), vector: { enabled: false } },
            },
          },
        },
      },
      agentId: "main",
    });

    expect(result.manager).not.toBeNull();
    manager = result.manager as MemoryIndexManager;

    await manager.sync({ force: true });

    // Search for "org mode heading" which should match our custom embedding function
    const results = await manager.search("org mode heading", { maxResults: 10 });

    expect(results.length).toBeGreaterThan(0);

    // The chunk should include org headings
    const chunk = results.find((r) => r.snippet.includes("Deep Section"));
    expect(chunk).toBeDefined();
  });

  it("still uses markdown chunking for .md files", async () => {
    const mdContent = `# Markdown Heading

Some markdown content here with code.

\`\`\`python
def example():
    return "hello"
\`\`\`

More content.`;

    const mdFile = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(mdFile, mdContent);

    const result = await getMemorySearchManager({
      cfg: {
        agents: {
          defaults: {
            workspace: workspaceDir,
            memorySearch: {
              provider: "local",
              model: "mock-embed",
              store: { path: path.join(tmpDir, "memory.db"), vector: { enabled: false } },
            },
          },
        },
      },
      agentId: "main",
    });

    expect(result.manager).not.toBeNull();
    manager = result.manager as MemoryIndexManager;

    await manager.sync({ force: true });

    const results = await manager.search("markdown heading", { maxResults: 5 });

    // Should successfully index and search markdown files
    expect(results.length).toBeGreaterThan(0);
  });
});
