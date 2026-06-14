import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Smoke/snapshot test for the Wise design tokens.
 *
 * Approach: read the source token stylesheets (`tokens.css` and `tailwind.css`)
 * from disk and assert the key wise/DESIGN.md values are present. This is the
 * most stable approach — it avoids invoking the Tailwind compiler in-test
 * (environment/version sensitive) while still guaranteeing the single source of
 * truth carries the Wise tokens and the Inter family. A snapshot of the raw
 * `--acx-*` token block guards against accidental drift.
 *
 * _Requirements: 20.2 (apply DESIGN.md color/typography/spacing/radius/elevation
 * tokens), 20.4 (set interface text in the Inter typeface family)._
 */

const tokensCssPath = resolve(process.cwd(), "src/ui/styles/tokens.css");
const tailwindCssPath = resolve(process.cwd(), "src/ui/styles/tailwind.css");

const tokensCss = readFileSync(tokensCssPath, "utf8");
const tailwindCss = readFileSync(tailwindCssPath, "utf8");

describe("Wise design tokens (tokens.css)", () => {
  it("declares the structural color tokens from wise/DESIGN.md", () => {
    // Wise lime-green is the single structural accent, carrying DARK ink text.
    expect(tokensCss).toContain("--acx-color-primary: #9fe870;");
    expect(tokensCss).toContain("--acx-color-primary-active: #cdffad;");
    expect(tokensCss).toContain("--acx-color-on-primary: #0e0f0c;");
    // Soft green tints for badges / subtle brand fills.
    expect(tokensCss).toContain("--acx-color-primary-pale: #e2f6d5;");
  });

  it("declares the sage-canvas surface tokens", () => {
    // Sage-tinted page canvas with white card interiors (the brand mood).
    expect(tokensCss).toContain("--acx-color-canvas: #e8ebe6;");
    expect(tokensCss).toContain("--acx-color-canvas-soft: #ffffff;");
    expect(tokensCss).toContain("--acx-color-surface: #ffffff;");
  });

  it("declares the ink (text) color tokens (near-black olive)", () => {
    expect(tokensCss).toContain("--acx-color-ink: #0e0f0c;");
    expect(tokensCss).toContain("--acx-color-ink-secondary: #454745;");
    expect(tokensCss).toContain("--acx-color-ink-muted: #868685;");
  });

  it("declares the Wise semantic palette", () => {
    expect(tokensCss).toContain("--acx-color-positive: #2ead4b;");
    expect(tokensCss).toContain("--acx-color-warning: #ffd11a;");
    expect(tokensCss).toContain("--acx-color-negative: #d03238;");
  });

  it("sets the Inter font family stack (Wise Sans substitute)", () => {
    // Requirement 20.4 — interface text set in the Inter typeface family.
    expect(tokensCss).toContain('"Inter"');
    expect(tokensCss).toMatch(/--acx-font-sans:\s*"Inter",\s*system-ui/);
  });

  it("declares the typography scale with Wise's heavy display weight", () => {
    // display-1: 64px / weight 900 (Wise's heavy display voice).
    expect(tokensCss).toContain("--acx-text-display-1: 64px;");
    expect(tokensCss).toContain("--acx-text-display-1-weight: 900;");
    expect(tokensCss).toContain("--acx-text-body-md: 16px;");
    expect(tokensCss).toContain("--acx-text-eyebrow: 12px;");
  });

  it("declares the spacing scale (4px base)", () => {
    expect(tokensCss).toContain("--acx-spacing-xxs: 2px;");
    expect(tokensCss).toContain("--acx-spacing-xs: 4px;");
    expect(tokensCss).toContain("--acx-spacing-lg: 16px;");
    expect(tokensCss).toContain("--acx-spacing-xl: 24px;");
  });

  it("declares the border radius scale (Wise 24px canonical)", () => {
    expect(tokensCss).toContain("--acx-radius-md: 12px;");
    expect(tokensCss).toContain("--acx-radius-lg: 16px;");
    expect(tokensCss).toContain("--acx-radius-xl: 24px;");
    expect(tokensCss).toContain("--acx-radius-full: 9999px;");
  });

  it("declares the elevation shadow tokens", () => {
    expect(tokensCss).toContain("--acx-shadow-soft:");
    expect(tokensCss).toContain("--acx-shadow-elevated:");
    // The deepest stop of the light elevated stack (warm near-black ink).
    expect(tokensCss).toContain("rgba(14, 15, 12, 0.12) 0px 24px 56px");
  });

  it("declares a dark theme via prefers-color-scheme and a forced override", () => {
    // Auto dark via system preference.
    expect(tokensCss).toContain("@media (prefers-color-scheme: dark)");
    // Forced dark / light overrides for explicit opt-in.
    expect(tokensCss).toContain('[data-acx-theme="dark"]');
    expect(tokensCss).toContain('[data-acx-theme="light"]');
    // Wise dark canvas is the near-black olive ink; the green accent persists.
    expect(tokensCss).toContain("#0e0f0c");
    expect(tokensCss).toContain("#9fe870");
  });

  it("declares theme-adaptive semantic interaction fills and scrim", () => {
    expect(tokensCss).toContain("--acx-fill-subtle:");
    expect(tokensCss).toContain("--acx-fill-hover:");
    expect(tokensCss).toContain("--acx-fill-active:");
    expect(tokensCss).toContain("--acx-scrim:");
    expect(tokensCss).toContain("--acx-color-surface-raised:");
  });

  it("scopes tokens to both :root and :host for Shadow DOM surfaces", () => {
    expect(tokensCss).toMatch(/:root,\s*:host\s*\{/);
  });
});

describe("Tailwind v4 theme mapping (tailwind.css)", () => {
  it("imports Tailwind and the raw token sheet", () => {
    expect(tailwindCss).toContain('@import "tailwindcss";');
    expect(tailwindCss).toContain('@import "./tokens.css";');
  });

  it("exposes a @theme block mapping Wise tokens to Tailwind namespaces", () => {
    expect(tailwindCss).toContain("@theme {");
    expect(tailwindCss).toContain("--color-primary: var(--acx-color-primary);");
    expect(tailwindCss).toContain(
      "--color-canvas-soft: var(--acx-color-canvas-soft);",
    );
    // Wise semantic + brand-tint tokens are exposed for utilities.
    expect(tailwindCss).toContain("--color-positive: var(--acx-color-positive);");
    expect(tailwindCss).toContain(
      "--color-primary-pale: var(--acx-color-primary-pale);",
    );
    expect(tailwindCss).toContain("--text-display-1: 64px;");
    expect(tailwindCss).toContain("--spacing-lg: 16px;");
    expect(tailwindCss).toContain("--radius-xl: 24px;");
  });

  it("sets the Inter font family in the Tailwind theme", () => {
    expect(tailwindCss).toContain('--font-sans: "Inter"');
  });
});

describe("token snapshot", () => {
  it("matches the raw --acx-* custom property declarations", () => {
    // Capture every `--acx-...: ...;` declaration in source order so any
    // accidental change to a token value or name is surfaced as a diff.
    const declarations = (tokensCss.match(/--acx-[\w-]+:[^;]+;/g) ?? []).map(
      (line) => line.replace(/\s+/g, " ").trim(),
    );
    expect(declarations).toMatchSnapshot();
  });
});
