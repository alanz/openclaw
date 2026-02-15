import type { MemoryChunk } from "./internal.js";
import { hashText } from "./internal.js";

/**
 * Org-mode structural element types
 */
type OrgElementType = "heading" | "property-drawer" | "block" | "drawer" | "content";

/**
 * Represents a parsed org-mode structural element
 */
interface OrgElement {
  type: OrgElementType;
  level?: number; // For headings: number of asterisks
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Parse org-mode content into structural elements.
 * Uses regex-based detection for common org-mode structures.
 *
 * Detected structures:
 * - Headings: Lines starting with asterisks (*)
 * - Property drawers: :PROPERTIES: ... :END:
 * - Blocks: #+BEGIN_* ... #+END_*
 * - General drawers: :NAME: ... :END:
 * - Content: Everything else
 */
export function parseOrgStructure(content: string): OrgElement[] {
  const lines = content.split("\n");
  const elements: OrgElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Detect heading: /^\*+ /
    const headingMatch = line.match(/^(\*+)\s+(.*)$/);
    if (headingMatch) {
      elements.push({
        type: "heading",
        level: headingMatch[1].length,
        startLine: i + 1,
        endLine: i + 1,
        text: line,
      });
      i += 1;
      continue;
    }

    // Detect property drawer: :PROPERTIES:
    if (trimmed === ":PROPERTIES:") {
      const endIdx = findEndMarker(lines, i + 1, ":END:");
      if (endIdx !== -1) {
        elements.push({
          type: "property-drawer",
          startLine: i + 1,
          endLine: endIdx + 1,
          text: lines.slice(i, endIdx + 1).join("\n"),
        });
        i = endIdx + 1;
        continue;
      }
    }

    // Detect general drawer: :NAME:
    const drawerMatch = trimmed.match(/^:([A-Z][A-Z0-9_-]*):$/);
    if (drawerMatch && drawerMatch[1] !== "END") {
      const endIdx = findEndMarker(lines, i + 1, ":END:");
      if (endIdx !== -1) {
        elements.push({
          type: "drawer",
          startLine: i + 1,
          endLine: endIdx + 1,
          text: lines.slice(i, endIdx + 1).join("\n"),
        });
        i = endIdx + 1;
        continue;
      }
    }

    // Detect block: #+BEGIN_*
    const blockMatch = trimmed.match(/^#\+BEGIN_(\w+)/i);
    if (blockMatch) {
      const blockType = blockMatch[1].toUpperCase();
      const endIdx = findEndMarker(lines, i + 1, `#+END_${blockType}`, true);
      if (endIdx !== -1) {
        elements.push({
          type: "block",
          startLine: i + 1,
          endLine: endIdx + 1,
          text: lines.slice(i, endIdx + 1).join("\n"),
        });
        i = endIdx + 1;
        continue;
      }
    }

    // Regular content line
    elements.push({
      type: "content",
      startLine: i + 1,
      endLine: i + 1,
      text: line,
    });
    i += 1;
  }

  return elements;
}

/**
 * Find the line index of an end marker (e.g., :END:, #+END_*)
 */
function findEndMarker(
  lines: string[],
  startIdx: number,
  marker: string,
  caseInsensitive = false,
): number {
  const searchMarker = caseInsensitive ? marker.toUpperCase() : marker;

  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const comparison = caseInsensitive ? trimmed.toUpperCase() : trimmed;

    if (comparison === searchMarker) {
      return i;
    }
  }

  return -1;
}

/**
 * Chunk org-mode content with awareness of structural elements.
 *
 * Strategy:
 * 1. Parse org structure to identify headings, blocks, drawers, etc.
 * 2. Chunk at natural boundaries (headings) while respecting size limits
 * 3. Never split atomic elements (blocks, drawers) across chunks
 * 4. Include parent heading context in each chunk for better search results
 * 5. Maintain heading hierarchy stack to provide context
 *
 * @param content - Org-mode file content
 * @param chunking - Chunking configuration (tokens and overlap)
 * @returns Array of memory chunks with org-aware boundaries
 */
export function chunkOrgMode(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const elements = parseOrgStructure(content);
  const maxChars = Math.max(32, chunking.tokens * 4);
  const chunks: MemoryChunk[] = [];

  // Track heading hierarchy to provide context
  let headingStack: OrgElement[] = [];

  // Current chunk being built
  let currentElements: OrgElement[] = [];
  let currentSize = 0;

  const flushChunk = () => {
    if (currentElements.length === 0) {
      return;
    }

    // Build chunk text with optional heading context
    const parts: string[] = [];

    // Add parent heading context if we're in a section
    if (headingStack.length > 0 && currentElements[0]?.type !== "heading") {
      parts.push(headingStack.map((h) => h.text).join("\n"));
      parts.push(""); // Blank line separator
    }

    // Add the chunk content
    parts.push(currentElements.map((e) => e.text).join("\n"));

    const text = parts.join("\n");
    const firstElement = currentElements[0];
    const lastElement = currentElements[currentElements.length - 1];

    if (!firstElement || !lastElement) {
      return;
    }

    chunks.push({
      startLine: firstElement.startLine,
      endLine: lastElement.endLine,
      text,
      hash: hashText(text),
    });

    currentElements = [];
    currentSize = 0;
  };

  for (const element of elements) {
    const elementSize = element.text.length + 1; // +1 for newline

    // Update heading hierarchy stack
    if (element.type === "heading") {
      const level = element.level ?? 0;

      // Pop headings at same or deeper level
      headingStack = headingStack.filter((h) => (h.level ?? 0) < level);

      // Add current heading to stack
      headingStack.push(element);

      // Start new chunk at significant headings if current chunk is substantial
      // This prevents tiny chunks while allowing related content to stay together
      if (currentSize > maxChars * 0.5 && currentElements.length > 0) {
        flushChunk();
      }
    }

    // Atomic elements (blocks, drawers) should never be split
    if (
      element.type === "block" ||
      element.type === "drawer" ||
      element.type === "property-drawer"
    ) {
      // If adding this would exceed max size and we have content, flush first
      if (currentSize + elementSize > maxChars && currentElements.length > 0) {
        flushChunk();
      }

      // Add the whole atomic element (even if it exceeds max size)
      currentElements.push(element);
      currentSize += elementSize;
      continue;
    }

    // Regular content and headings
    // Flush if adding this element would exceed max size
    if (currentSize + elementSize > maxChars && currentElements.length > 0) {
      flushChunk();
    }

    currentElements.push(element);
    currentSize += elementSize;
  }

  // Flush any remaining content
  flushChunk();

  return chunks;
}

/**
 * Group consecutive content-type elements to reduce fragmentation.
 * This is useful for merging adjacent content lines before chunking.
 */
export function mergeContentElements(elements: OrgElement[]): OrgElement[] {
  const merged: OrgElement[] = [];
  let contentGroup: OrgElement[] = [];

  const flushContentGroup = () => {
    if (contentGroup.length === 0) {
      return;
    }

    if (contentGroup.length === 1) {
      merged.push(contentGroup[0]);
    } else {
      // Merge multiple content lines
      const first = contentGroup[0];
      const last = contentGroup[contentGroup.length - 1];
      if (first && last) {
        merged.push({
          type: "content",
          startLine: first.startLine,
          endLine: last.endLine,
          text: contentGroup.map((e) => e.text).join("\n"),
        });
      }
    }

    contentGroup = [];
  };

  for (const element of elements) {
    if (element.type === "content") {
      contentGroup.push(element);
    } else {
      flushContentGroup();
      merged.push(element);
    }
  }

  flushContentGroup();
  return merged;
}
