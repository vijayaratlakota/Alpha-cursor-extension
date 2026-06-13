// Property-based test for context-aware tool-set composition (task 10.4).
//
// Exercises the PURE `resolveToolSet(context)` and the helpers `toolAppliesTo`,
// `isContextIndependent`, and `getToolCatalog` exported from ./tools.ts.
//
// Property 2 (Req 2.6): for ANY ContextType, the resolved tool set must contain
//   - EVERY context-independent tool (contexts === "all"), and
//   - EXACTLY the context-specific tools whose `contexts` include that context,
//   - and NO inapplicable context-specific tool.
//
// We property-test across all four ContextTypes at min 100 runs.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ContextType } from "./context";
import {
  resolveToolSet,
  toolAppliesTo,
  isContextIndependent,
  getToolCatalog,
  type Tool,
} from "./tools";

const ALL_CONTEXTS: readonly ContextType[] = [
  "selected-text",
  "image",
  "video",
  "generic-page",
];

const contextArb = fc.constantFrom<ContextType>(...ALL_CONTEXTS);

/** Tools the full catalog marks context-independent (`contexts === "all"`). */
function contextIndependentTools(): Tool[] {
  return getToolCatalog().filter(isContextIndependent);
}

/** Context-specific tools whose `contexts` array includes `context`. */
function applicableSpecificTools(context: ContextType): Tool[] {
  return getToolCatalog().filter(
    (tool) => tool.contexts !== "all" && tool.contexts.includes(context),
  );
}

describe("Property 2: Tool set always includes context-independent tools", () => {
  // Feature: alpha-cursor-extension, Property 2: Tool set always includes context-independent tools
  // Validates: Requirements 2.6
  it("includes every context-independent tool plus exactly the applicable context-specific tools", () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        const resolved = resolveToolSet(context);
        const resolvedIds = new Set(resolved.map((t) => t.id));

        // 1) Every context-independent tool is present.
        for (const tool of contextIndependentTools()) {
          expect(resolvedIds.has(tool.id)).toBe(true);
        }

        // 2) Every applicable context-specific tool is present.
        for (const tool of applicableSpecificTools(context)) {
          expect(resolvedIds.has(tool.id)).toBe(true);
        }

        // 3) NO inapplicable context-specific tool leaks in, and every member
        //    is genuinely applicable to this context.
        for (const tool of resolved) {
          expect(toolAppliesTo(tool, context)).toBe(true);
          if (!isContextIndependent(tool)) {
            expect(tool.contexts).not.toBe("all");
            // narrow: context-specific tools store an array of contexts.
            const contexts = tool.contexts as ContextType[];
            expect(contexts.includes(context)).toBe(true);
          }
        }

        // 4) Set equality: resolved === independent ∪ applicable-specific,
        //    with no duplicates.
        const expectedIds = new Set<string>([
          ...contextIndependentTools().map((t) => t.id),
          ...applicableSpecificTools(context).map((t) => t.id),
        ]);
        expect(resolvedIds.size).toBe(resolved.length); // no duplicates
        expect(resolvedIds).toEqual(expectedIds);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: alpha-cursor-extension, Property 2: Tool set always includes context-independent tools
  // Validates: Requirements 2.6
  it("preserves catalog display order in the resolved subset", () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        const resolved = resolveToolSet(context);
        const expectedOrder = getToolCatalog()
          .filter((tool) => toolAppliesTo(tool, context))
          .map((tool) => tool.id);
        expect(resolved.map((tool) => tool.id)).toEqual(expectedOrder);
      }),
      { numRuns: 100 },
    );
  });
});
