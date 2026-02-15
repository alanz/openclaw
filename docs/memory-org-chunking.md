# Org-Mode Aware Chunking for Memory System

## Executive Summary

This document investigates adding org-mode aware chunking to the memory system to improve semantic coherence when indexing `.org` files. Currently, the system uses simple line-based chunking which can split org-mode structural elements awkwardly.

## Existing NPM Packages

### Recommended: uniorg

**[uniorg](https://github.com/rasendubi/uniorg)** is the best TypeScript-native option for org-mode parsing.

**Key Features:**

- Written entirely in TypeScript with full type definitions
- Accurate parser following [Org Syntax](https://orgmode.org/worg/org-syntax.html) specification
- Integrates with the unified ecosystem
- Models behavior on Emacs' org-element.el

**Package Ecosystem:**

- `uniorg-parse` - Parse org files to syntax trees
- `uniorg-stringify` - Convert trees back to org format
- `uniorg-rehype` - Transform to HTML-compatible format
- `uniorg-extract-keywords` - Extract document metadata
- `uniorg-slug` - Generate heading anchors

**Installation:**

```bash
pnpm add uniorg-parse
```

**Basic Usage:**

```typescript
import { unified } from "unified";
import uniorgParse from "uniorg-parse";

const processor = unified().use(uniorgParse);
const tree = processor.parse("* Heading\nContent here");
```

### Alternative: orga (orgajs)

**[orgajs](https://github.com/orgapp/orgajs)** is a flexible JavaScript parser for org-mode.

**Pros:**

- Active development (updated 4 months ago)
- Produces AST format
- Multiple utility packages

**Cons:**

- Primarily JavaScript (less TypeScript support than uniorg)

### Not Recommended: org-mode-parser

Last updated 9 years ago, not actively maintained.

## Org-Mode Syntax Overview

### Core Structural Elements

1. **Headings** - Lines starting with `*` (asterisks) at column 0

   ```org
   * Level 1 Heading
   ** Level 2 Heading
   *** Level 3 Heading
   ```

2. **Heading Components**
   - TODO keywords: `TODO`, `DONE`, custom states
   - Priority: `[#A]`, `[#B]`, `[#C]`
   - Tags: `:tag1:tag2:`

   ```org
   ** TODO [#A] Important Task :work:urgent:
   ```

3. **Property Drawers** - Metadata attached to headings

   ```org
   * Heading
   :PROPERTIES:
   :ID: unique-id
   :CREATED: [2026-02-15]
   :END:
   ```

4. **Blocks** - Container elements

   ```org
   #+BEGIN_SRC python
   def hello():
       print("Hello")
   #+END_SRC

   #+BEGIN_QUOTE
   Famous quote here
   #+END_QUOTE
   ```

5. **Lists** - Bulleted or numbered

   ```org
   - Item 1
     - Nested item
   - Item 2

   1. First
   2. Second
   ```

6. **Drawers** - Named containers
   ```org
   :LOGBOOK:
   - Note taken on [2026-02-15]
   :END:
   ```

### Critical Parsing Rules

- Headings are context-free and can appear anywhere
- Property drawers must immediately follow headings
- Blank lines belong to the narrowest preceding scope
- Indentation is semantically meaningful for lists
- Blocks should not be split across chunks

## Current Chunking Implementation

The current `chunkMarkdown()` function in `src/memory/internal.ts`:

- Splits content by lines
- Accumulates lines up to `maxChars` (tokens × 4)
- Carries overlap from previous chunk
- **No awareness of document structure**

**Problems for Org Files:**

1. Can split headings from their content
2. Can split property drawers in the middle
3. Can break code blocks across chunks
4. Doesn't preserve hierarchical context

## Proposed Org-Aware Chunking Strategy

### Option 1: Lightweight Regex-Based Parser (Recommended for MVP)

Implement a basic org-structure detector without external dependencies.

**Algorithm:**

1. Parse heading structure using regex: `/^\*+\s/`
2. Identify structural boundaries (headings, blocks, drawers)
3. Chunk at natural boundaries while respecting size limits
4. Include parent heading context in each chunk

**Benefits:**

- No external dependencies
- Fast and simple
- Good enough for 80% of use cases
- Easy to maintain

**Implementation Sketch:**

```typescript
interface OrgElement {
  type: "heading" | "property-drawer" | "block" | "content";
  level?: number; // for headings
  startLine: number;
  endLine: number;
  text: string;
}

function parseOrgStructure(content: string): OrgElement[] {
  const lines = content.split("\n");
  const elements: OrgElement[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect heading: /^\*+\s/
    const headingMatch = line.match(/^(\*+)\s+(.*)$/);
    if (headingMatch) {
      elements.push({
        type: "heading",
        level: headingMatch[1].length,
        startLine: i + 1,
        endLine: i + 1,
        text: line,
      });
      continue;
    }

    // Detect property drawer start: /^\s*:PROPERTIES:\s*$/
    if (line.trim() === ":PROPERTIES:") {
      // Find :END:
      const endIdx = lines.findIndex((l, idx) => idx > i && l.trim() === ":END:");
      if (endIdx !== -1) {
        elements.push({
          type: "property-drawer",
          startLine: i + 1,
          endLine: endIdx + 1,
          text: lines.slice(i, endIdx + 1).join("\n"),
        });
        i = endIdx; // Skip to end
        continue;
      }
    }

    // Detect block start: /^\s*#\+BEGIN_/
    if (line.trim().match(/^#\+BEGIN_/i)) {
      const blockType = line.trim().split(/\s+/)[0];
      const endPattern = blockType.replace("BEGIN", "END");
      const endIdx = lines.findIndex(
        (l, idx) => idx > i && l.trim().toUpperCase().startsWith(endPattern),
      );
      if (endIdx !== -1) {
        elements.push({
          type: "block",
          startLine: i + 1,
          endLine: endIdx + 1,
          text: lines.slice(i, endIdx + 1).join("\n"),
        });
        i = endIdx;
        continue;
      }
    }

    // Regular content
    elements.push({
      type: "content",
      startLine: i + 1,
      endLine: i + 1,
      text: line,
    });
  }

  return elements;
}

function chunkOrgMode(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const elements = parseOrgStructure(content);
  const maxChars = Math.max(32, chunking.tokens * 4);
  const chunks: MemoryChunk[] = [];

  let currentHeadingStack: OrgElement[] = [];
  let currentChunk: OrgElement[] = [];
  let currentSize = 0;

  const flushChunk = () => {
    if (currentChunk.length === 0) return;

    // Include heading context
    const headingContext = currentHeadingStack.map((h) => h.text).join("\n");

    const chunkText = currentChunk.map((e) => e.text).join("\n");

    const fullText = headingContext ? `${headingContext}\n\n${chunkText}` : chunkText;

    chunks.push({
      startLine: currentChunk[0].startLine,
      endLine: currentChunk[currentChunk.length - 1].endLine,
      text: fullText,
      hash: hashText(fullText),
    });

    currentChunk = [];
    currentSize = 0;
  };

  for (const element of elements) {
    const elementSize = element.text.length;

    // Update heading stack
    if (element.type === "heading") {
      // Pop headings at same or deeper level
      const level = element.level || 0;
      currentHeadingStack = currentHeadingStack.filter((h) => (h.level || 0) < level);
      currentHeadingStack.push(element);

      // Start new chunk at headings if current is large enough
      if (currentSize > maxChars * 0.5) {
        flushChunk();
      }
    }

    // Don't split blocks or property drawers
    if (element.type === "block" || element.type === "property-drawer") {
      if (currentSize + elementSize > maxChars && currentChunk.length > 0) {
        flushChunk();
      }
      currentChunk.push(element);
      currentSize += elementSize;
      continue;
    }

    // Regular content
    if (currentSize + elementSize > maxChars && currentChunk.length > 0) {
      flushChunk();
    }

    currentChunk.push(element);
    currentSize += elementSize;
  }

  flushChunk();
  return chunks;
}
```

### Option 2: Full AST-Based Parser with uniorg

Use uniorg to build a complete AST and chunk based on semantic boundaries.

**Benefits:**

- Most accurate parsing
- Handles all org-mode syntax correctly
- Can extract rich metadata

**Drawbacks:**

- Additional dependency (~500KB)
- More complex implementation
- Slower parsing
- Overkill for simple chunking needs

**When to Consider:**

- If we need org → HTML conversion
- If we want to extract and index org metadata (properties, tags)
- If we need to handle complex org documents with all features

## Recommendation

**Start with Option 1 (Lightweight Regex-Based):**

1. **Immediate value** - Better chunking with minimal complexity
2. **No dependencies** - Keep the memory system lightweight
3. **Maintainable** - Simple regex patterns easy to debug
4. **Sufficient** - Handles 90% of common org-mode structures
5. **Extensible** - Can upgrade to uniorg later if needed

**Implementation Plan:**

1. Add `chunkOrgMode()` function to `internal.ts`
2. Detect file extension in indexing code
3. Route `.org` files to org-aware chunker
4. Add comprehensive tests with real org examples
5. Monitor chunking quality in practice

**Future Enhancements:**

- Add support for more org elements (tables, lists)
- Extract and index org properties as metadata
- Consider uniorg if we need org → markdown conversion
- Add heading path to chunk metadata for better citations

## Testing Strategy

Create test files covering:

- Simple headings with content
- Nested headings (3+ levels)
- Property drawers
- Code blocks (SRC blocks)
- Quote blocks
- Mixed content
- Large documents (chunking boundary conditions)

## Performance Considerations

- Regex parsing is O(n) where n = lines
- Should be comparable to current markdown chunking
- Memory overhead minimal (tracking heading stack only)
- Can optimize hot paths if needed

## Migration Path

1. **Phase 1**: Implement basic org chunker (headings + blocks)
2. **Phase 2**: Add property drawer and drawer support
3. **Phase 3**: Consider uniorg integration if metadata extraction becomes important
4. **Phase 4**: Potentially make chunking strategy configurable per file type

## Related Resources

- [Org Syntax Specification](https://orgmode.org/worg/org-syntax.html)
- [The Org Manual](https://orgmode.org/org.html)
- [uniorg GitHub](https://github.com/rasendubi/uniorg)
- [orgajs GitHub](https://github.com/orgapp/orgajs)

## References

Sources:

- [uniorg - Org-Mode parser for JavaScript/TypeScript](https://github.com/rasendubi/uniorg)
- [orgajs - Parse org-mode content into AST](https://github.com/orgapp/orgajs)
- [Org Syntax Specification](https://orgmode.org/worg/org-syntax.html)
- [The Org Manual](https://orgmode.org/org.html)
- [Property Syntax Documentation](https://orgmode.org/manual/Property-Syntax.html)
- [Drawers Documentation](https://orgmode.org/manual/Drawers.html)
