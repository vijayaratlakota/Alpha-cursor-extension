import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Task 3.2 — Smoke/snapshot test for the Notion design tokens.
 *
 * Approach: read the source token stylesheets (`tokens.css` and `tailwind.css`)
 * from disk and assert the key DESIGN.md values are present. This is the most
 * stable approach — it avoids invoking the Tailwind compiler in-test (which is
 * environment/version sensitive) while still guaranteeing the single source of
 * truth carries the Notion tokens and the Inter family. A snapshot of the raw
 * `--acx-*` token block guards against accidental drift.
 *
 * _Requirements: 20.2 (apply DESIGN.md color/typography/spacing/radius/elevation
 * tokens), 20.4 (set interface text in the Inter typeface family)._
 */

const tokensCssPath = resolve(process.cwd(), "src/ui/styles/tokens.css");
const tailwindCssPath = resolve(process.cwd(), "src/ui/styles/tailwind.css");

const tokensCss = readFileSync(tokensCssPath, "utf8");
const tailwindCss = readFileSync(tailwindCssPath, "utf8");

describe("Notion design tokens (tokens.css)", () => {
  it("declares the structural color tokens from DESIGN.md", () => {
    // Notion blue is the single structural accent (Requirement 20.2/20.3).
    expect(tokensCss).toContain("--acx-color-primary: #0075de;");
    expect(tokensCss).toContain("--acx-color-primary-active: #005bab;");
    expect(tokensCss).toContain("--acx-color-secondary: #213183;");
    expect(tokensCss).toContain("--acx-color-on-primary: #ffffff;");
  });

  it("declares the warm paper-calm surface tokens", () => {
    expect(tokensCss).toContain("--acx-color-canvas: #ffffff;");
    expect(tokensCss).toContain("--acx-color-canvas-soft: #f6f5f4;");
    expect(tokensCss).toContain("--acx-color-surface: #ffffff;");
    expect(tokensCss).toContain("--acx-color-hairline: #e6e6e6;");
  });

  it("declares the ink (text) color tokens", () => {
    expect(tokensCss).toContain("--acx-color-ink: #1a1a1a;");
    expect(tokensCss).toContain("--acx-color-ink-secondary: #31302e;");
    expect(tokensCss).toContain("--acx-color-ink-muted: #615d59;");
    expect(tokensCss).toContain("--acx-color-ink-faint: #a39e98;");
  });

  it("declares the decorative sticker palette", () => {
    expect(tokensCss).toContain("--acx-color-accent-sky: #62aef0;");
    expect(tokensCss).toContain("--acx-color-accent-purple: #d6b6f6;");
    expect(tokensCss).toContain("--acx-color-accent-pink: #ff64c8;");
    expect(tokensCss).toContain("--acx-color-accent-orange: #dd5b00;");
    expect(tokensCss).toContain("--acx-color-accent-teal: #2a9d99;");
    expect(tokensCss).toContain("--acx-color-accent-green: #1aae39;");
  });

  it("sets the Inter font family stack (NotionInter substitute)", () => {
    // Requirement 20.4 — interface text set in the Inter typeface family.
    expect(tokensCss).toContain('"Inter"');
    expect(tokensCss).toMatch(
      /--acx-font-sans:\s*"Inter",\s*-apple-system,\s*system-ui,\s*"Segoe UI",\s*Helvetica,\s*Arial,\s*sans-serif;/,
    );
  });

  it("declares the typography scale with Notion display tracking", () => {
    // display-1: 64px / 700 / 1.0 / -2.125px (the signature tight tracking).
    expect(tokensCss).toContain("--acx-text-display-1: 64px;");
    expect(tokensCss).toContain("--acx-text-display-1-weight: 700;");
    expect(tokensCss).toContain("--acx-text-display-1-letter-spacing: -2.125px;");
    expect(tokensCss).toContain("--acx-text-body-md: 16px;");
    expect(tokensCss).toContain("--acx-text-eyebrow: 12px;");
  });

  it("declares the spacing scale (8px base)", () => {
    expect(tokensCss).toContain("--acx-spacing-xxs: 4px;");
    expect(tokensCss).toContain("--acx-spacing-md: 16px;");
    expect(tokensCss).toContain("--acx-spacing-lg: 24px;");
    expect(tokensCss).toContain("--acx-spacing-xxl: 32px;");
  });

  it("declares the border radius scale", () => {
    expect(tokensCss).toContain("--acx-radius-xs: 4px;");
    expect(tokensCss).toContain("--acx-radius-md: 8px;");
    expect(tokensCss).toContain("--acx-radius-lg: 12px;");
    expect(tokensCss).toContain("--acx-radius-full: 9999px;");
  });

  it("declares the barely-there elevation shadow tokens", () => {
    expect(tokensCss).toContain("--acx-shadow-soft:");
    expect(tokensCss).toContain("--acx-shadow-elevated:");
    // The deepest stop of the light elevated stack (warm near-black).
    expect(tokensCss).toContain("rgba(15, 15, 15, 0.12) 0px 23px 52px");
  });

  it("declares a dark theme via prefers-color-scheme and a forced override", () => {
    // Auto dark via system preference.
    expect(tokensCss).toContain("@media (prefers-color-scheme: dark)");
    // Forced dark / light overrides for explicit opt-in.
    expect(tokensCss).toContain('[data-acx-theme="dark"]');
    expect(tokensCss).toContain('[data-acx-theme="light"]');
    // Dark canvas is the warm Notion near-black, and the accent brightens.
    expect(tokensCss).toContain("#191919");
    expect(tokensCss).toContain("#3d96f5");
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

  it("exposes a @theme block mapping Notion tokens to Tailwind namespaces", () => {
    expect(tailwindCss).toContain("@theme {");
    expect(tailwindCss).toContain("--color-primary: var(--acx-color-primary);");
    expect(tailwindCss).toContain(
      "--color-canvas-soft: var(--acx-color-canvas-soft);",
    );
    expect(tailwindCss).toContain("--text-display-1: 64px;");
    expect(tailwindCss).toContain("--text-display-1--letter-spacing: -2.125px;");
    expect(tailwindCss).toContain("--spacing-lg: 24px;");
    expect(tailwindCss).toContain("--radius-lg: 12px;");
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
