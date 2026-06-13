import { describe, it, expect } from "vitest";
import fc from "fast-check";

// Scaffolding smoke test (task 1). Confirms the Vitest jsdom environment and
// fast-check are wired correctly. Replaced/expanded by real tests in later tasks.
describe("project scaffolding", () => {
  it("runs in a jsdom environment with DOM available", () => {
    const el = document.createElement("div");
    el.textContent = "alpha-cursor";
    expect(el.textContent).toBe("alpha-cursor");
  });

  it("has fast-check available for property-based tests", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 },
    );
  });
});
