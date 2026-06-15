import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Smoke/snapshot test for the "Create Next App" retro design tokens.
 *
 * Approach: read the source token stylesheets (`tokens.css` and `tailwind.css`)
 * from disk and assert the key design values are present. This avoids invoking
 * the Tailwind compiler in-test (environment/version sensitive) while still
 * guaranteeing the single source of truth carries the retro tokens and the
 * VT323 family. A snapshot of the raw `--acx-*` token block guards against
 * accidental drift.
 *
 * _Requirements: 20.2 (apply DESIGN.md color/typography/spacing/radius/elevation
 * tokens), 20.4 (set interface text in the specified typeface family)._
 */

const tokensCssPath = resolve(process.cwd(), "src/ui/styles/tokens.css");
const tailwindCssPath = resolve(process.cwd(), "src/ui/styles/tailwind.css");

const tokensCss = readFileSync(tokensCssPath, "utf8");
const tailwindCss = readFileSync(tailwindCssPath, "utf8");

describe("retro design tokens (tokens.css)", () => {
  it("declares the structural color tokens (yellow primary, dark ink)", () => {
    // Yellow is the single structural accent, carrying DARK ink text.
    expect(tokensCss).toContain("--acx-color-primary: #ffd913;");
    expect(tokensCss).toContain("--acx-color-primary-active: #ffe957;");
    expect(tokensCss).toContain("--acx-color-on-primary: #0a0118;");
    // Coral-red secondary accent.
    expect(tokensCss).toContain("--acx-color-secondary: #ff5a5f;");
  });

  it("declares the mint-canvas / white-card surface tokens", () => {
    expect(tokensCss).toContain("--acx-color-canvas: #bff0d0;");
    expect(tokensCss).toContain("--acx-color-canvas-soft: #ffffff;");
    expect(tokensCss).toContain("--acx-color-surface: #ffffff;");
    // Thick black brutalist border.
    expect(tokensCss).toContain("--acx-color-hairline: #0a0118;");
  });

  it("declares the ink (text) color tokens (near-black pixel)", () => {
    expect(tokensCss).toContain("--acx-color-ink: #0a0118;");
    expect(tokensCss).toContain("--acx-color-ink-secondary: #2c1d55;");
    expect(tokensCss).toContain("--acx-color-ink-muted: #6b5b95;");
  });

  it("declares the semantic palette", () => {
    expect(tokensCss).toContain("--acx-color-positive: #2bb673;");
    expect(tokensCss).toContain("--acx-color-warning: #ffd913;");
    expect(tokensCss).toContain("--acx-color-negative: #ff5a5f;");
  });

  it("sets the VT323 font family stack", () => {
    // Requirement 20.4 — interface text set in the specified typeface family.
    expect(tokensCss).toContain('"VT323"');
    expect(tokensCss).toMatch(/--acx-font-sans:\s*"VT323"/);
  });

  it("declares the typography scale (VT323 single weight)", () => {
    expect(tokensCss).toContain("--acx-text-display-1: 64px;");
    expect(tokensCss).toContain("--acx-text-display-1-weight: 400;");
    expect(tokensCss).toContain("--acx-text-body-md: 18px;");
    expect(tokensCss).toContain("--acx-text-eyebrow: 14px;");
  });

  it("declares the spacing scale (8px base)", () => {
    expect(tokensCss).toContain("--acx-spacing-xxs: 2px;");
    expect(tokensCss).toContain("--acx-spacing-xs: 4px;");
    expect(tokensCss).toContain("--acx-spacing-lg: 16px;");
    expect(tokensCss).toContain("--acx-spacing-xl: 24px;");
  });

  it("declares the squared border radius scale", () => {
    expect(tokensCss).toContain("--acx-radius-md: 4px;");
    expect(tokensCss).toContain("--acx-radius-lg: 6px;");
    expect(tokensCss).toContain("--acx-radius-xl: 8px;");
    expect(tokensCss).toContain("--acx-radius-full: 9999px;");
  });

  it("declares the hard-offset shadow tokens (no blur)", () => {
    expect(tokensCss).toContain("--acx-shadow-soft:");
    expect(tokensCss).toContain("--acx-shadow-elevated:");
    // The brutalist drop is a solid black offset block (no blur radius).
    expect(tokensCss).toContain("#0a0118 6px 6px 0px 0px");
  });

  it("declares forced theme overrides resolving to the arcade palette", () => {
    expect(tokensCss).toContain('[data-acx-theme="dark"]');
    expect(tokensCss).toContain('[data-acx-theme="light"]');
    // The arcade palette: yellow accent on mint canvas.
    expect(tokensCss).toContain("#ffd913");
    expect(tokensCss).toContain("#bff0d0");
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

  it("exposes a @theme block mapping tokens to Tailwind namespaces", () => {
    expect(tailwindCss).toContain("@theme {");
    expect(tailwindCss).toContain("--color-primary: var(--acx-color-primary);");
    expect(tailwindCss).toContain(
      "--color-canvas-soft: var(--acx-color-canvas-soft);",
    );
    expect(tailwindCss).toContain("--color-positive: var(--acx-color-positive);");
    expect(tailwindCss).toContain(
      "--color-primary-pale: var(--acx-color-primary-pale);",
    );
    expect(tailwindCss).toContain("--text-display-1: 64px;");
    expect(tailwindCss).toContain("--spacing-lg: 16px;");
    expect(tailwindCss).toContain("--radius-xl: 8px;");
  });

  it("sets the VT323 font family in the Tailwind theme", () => {
    expect(tailwindCss).toContain('--font-sans: "VT323"');
  });

  it("bundles the VT323 font locally via @font-face", () => {
    expect(tailwindCss).toContain("@font-face");
    expect(tailwindCss).toContain('font-family: "VT323"');
    expect(tailwindCss).toContain("/fonts/vt323.woff2");
  });
});

describe("token snapshot", () => {
  it("matches the raw --acx-* custom property declarations", () => {
    const declarations = (tokensCss.match(/--acx-[\w-]+:[^;]+;/g) ?? []).map(
      (line) => line.replace(/\s+/g, " ").trim(),
    );
    expect(declarations).toMatchSnapshot();
  });
});
