# Investigation: Org-Mode Aware Chunking for Memory System

**Date:** 2026-02-15
**Investigator:** Claude Sonnet 4.5

## Summary

Investigated implementing org-mode structure-aware chunking for the memory indexing system. Successfully created a lightweight, dependency-free implementation that improves chunking quality for `.org` files.

## Key Findings

### 1. Existing NPM Packages

Three main options exist for org-mode parsing in TypeScript/JavaScript:

| Package                                           | TypeScript | Maintenance          | Recommendation            |
| ------------------------------------------------- | ---------- | -------------------- | ------------------------- |
| **[uniorg](https://github.com/rasendubi/uniorg)** | ✅ Native  | ✅ Active (5 mo ago) | **Best for full parsing** |
| **[orgajs](https://github.com/orgapp/orgajs)**    | ⚠️ Limited | ✅ Active (4 mo ago) | Good alternative          |
| org-mode-parser                                   | ❌ No      | ❌ 9 years old       | Not recommended           |

**Recommendation:** For our use case, a **custom lightweight parser** is better than adding a full dependency.

### 2. Org-Mode Structure

Key elements that affect chunking:

```org
* Heading                        # Must preserve hierarchy
:PROPERTIES:                     # Must not split from heading
:ID: abc-123
:END:

Regular content here.            # Can split at boundaries

#+BEGIN_SRC python               # NEVER split blocks
code here
#+END_SRC

:LOGBOOK:                        # Keep drawers intact
- Notes
:END:
```

**Critical Rules:**

- Headings define document hierarchy (asterisks at column 0)
- Property drawers must immediately follow headings
- Blocks (SRC, QUOTE, EXAMPLE) are atomic - never split
- Drawers are atomic containers
- Child sections should include parent heading context

### 3. Implementation Approach

**Created:** `src/memory/org-chunking.ts`

**Strategy:** Lightweight regex-based parser that:

1. Detects structural elements (headings, blocks, drawers)
2. Chunks at natural boundaries (headings)
3. Never splits atomic elements (blocks, property drawers)
4. Includes parent heading context for better search

**No external dependencies required** ✅

### 4. Test Results

Created comprehensive test suite: `src/memory/org-chunking.test.ts`

```
✓ src/memory/org-chunking.test.ts (24 tests) 10ms
```

**Coverage includes:**

- Heading detection (all levels)
- Property drawer handling
- Code block preservation
- Quote and example blocks
- General drawers (LOGBOOK, etc.)
- Nested heading context
- Large document handling
- Real-world example (research notes)

All tests pass ✅

## Implementation Details

### Core Functions

**`parseOrgStructure(content: string): OrgElement[]`**

- Parses org content into structural elements
- Uses regex patterns to detect headings, blocks, drawers
- Returns typed array of elements with line numbers

**`chunkOrgMode(content: string, chunking: ChunkConfig): MemoryChunk[]`**

- Chunks org content with structure awareness
- Maintains heading hierarchy stack
- Includes parent context in child chunks
- Respects atomic element boundaries

**`mergeContentElements(elements: OrgElement[]): OrgElement[]`**

- Helper to merge consecutive content lines
- Reduces fragmentation

### Example Chunking Behavior

**Input:**

```org
* Parent Heading

** Child Section
Some content here.

#+BEGIN_SRC python
def example():
    pass
#+END_SRC

More content.
```

**Output Chunks:**

1. Chunk contains parent + child heading + content
2. Code block kept intact (never split)
3. Each chunk includes heading context

### Performance

- Parsing: O(n) where n = number of lines
- Memory overhead: Minimal (heading stack only)
- Speed: Comparable to current markdown chunking
- No external dependencies

## Integration Plan

### Phase 1: Basic Integration (Recommended for immediate use)

1. Add file type detection in `buildFileEntry()`:

   ```typescript
   const isOrgFile = absPath.endsWith(".org");
   const chunks = isOrgFile ? chunkOrgMode(content, chunking) : chunkMarkdown(content, chunking);
   ```

2. Update `indexFile()` to use appropriate chunker

3. Ship with current .org file support

### Phase 2: Enhanced Features (Future)

- Extract org properties as metadata
- Index org tags separately
- Handle org links specially
- Support org-mode tables
- Parse TODO states

### Phase 3: Advanced (If needed)

- Consider uniorg integration for:
  - Org → Markdown conversion
  - Rich metadata extraction
  - Full org-element compatibility

## Comparison: Line-Based vs Org-Aware

**Scenario:** Chunking a code block in org file

### Line-Based (Current)

```
Chunk 1:
** Implementation
The code below shows...

#+BEGIN_SRC python
def generate_embed

--- SPLIT HERE (BAD!) ---

Chunk 2:
ding(text):
    return embeddings
#+END_SRC
```

❌ Code block split across chunks
❌ Context lost

### Org-Aware (New)

```
Chunk 1:
* Parent Section
** Implementation
The code below shows...

#+BEGIN_SRC python
def generate_embedding(text):
    return embeddings
#+END_SRC
```

✅ Code block intact
✅ Parent context preserved
✅ Semantic coherence maintained

## Recommendations

### Immediate Action ✅

**Ship the org-aware chunker** with the .org file support:

1. Already implemented (`org-chunking.ts`)
2. Fully tested (24 tests passing)
3. No dependencies
4. Minimal integration effort
5. Significant quality improvement

### Code Changes Required

**File: `src/memory/internal.ts`**

Add import:

```typescript
import { chunkOrgMode } from "./org-chunking.js";
```

Update `buildFileEntry()` or chunking call site:

```typescript
const chunks = absPath.endsWith(".org")
  ? chunkOrgMode(content, this.settings.chunking)
  : chunkMarkdown(content, this.settings.chunking);
```

**File: `src/memory/manager-embedding-ops.ts`** (or wherever chunks are created)

Same pattern - detect file type and route to appropriate chunker.

### Future Enhancements

**Low Priority:**

- Add more org element support (tables, lists)
- Extract and index org metadata
- Consider uniorg if conversion features needed

**Not Recommended:**

- Don't add full org parser unless needed
- Keep it simple and fast

## Files Created

1. ✅ `docs/memory-org-chunking.md` - Full design document
2. ✅ `src/memory/org-chunking.ts` - Implementation
3. ✅ `src/memory/org-chunking.test.ts` - Test suite (24 tests)
4. ✅ `docs/org-chunking-example.org` - Example org file
5. ✅ `docs/INVESTIGATION-org-chunking.md` - This summary

## Conclusion

**Ready to integrate** ✅

The org-aware chunker is production-ready:

- Lightweight (no dependencies)
- Well-tested (24 tests, 100% pass)
- Performance-efficient (O(n) parsing)
- Semantic improvement (preserves structure)

**Recommendation:** Integrate in next commit alongside .org file indexing support.

## Sources

- [uniorg - Accurate Org-Mode parser for JavaScript/TypeScript](https://github.com/rasendubi/uniorg)
- [orgajs - Parse org-mode content into AST](https://github.com/orgapp/orgajs)
- [Org Syntax Specification](https://orgmode.org/worg/org-syntax.html)
- [The Org Manual](https://orgmode.org/org.html)
- [Property Syntax Documentation](https://orgmode.org/manual/Property-Syntax.html)
- [Drawers Documentation](https://orgmode.org/manual/Drawers.html)
