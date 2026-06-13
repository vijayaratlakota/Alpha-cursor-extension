import { describe, it, expect } from "vitest";
import {
  createButton,
  createCard,
  createTextInput,
  createBadge,
  joinClasses,
  type ButtonVariant,
} from "./index";

/**
 * Task 6.3 — Component snapshot tests for the Notion UI primitives.
 *
 * These lock in the Tailwind utility-class output of each primitive/variant so
 * any drift away from the DESIGN.md Notion tokens (pill radii, hairline border,
 * surface/ink colors, soft shadow, reserved primary-blue focus ring) surfaces
 * as a snapshot diff. Explicit assertions cover the reserved focus ring, the
 * accessible-label enforcement for icon-only/unlabeled controls, and the
 * disabled treatment.
 *
 * _Validates: Requirements 20.1, 20.2, 20.3, 20.5, 20.7_
 */

describe("createButton — Notion-token conformance snapshots (Req 20.1, 20.2)", () => {
  const variants: ButtonVariant[] = [
    "primary",
    "secondary",
    "utility",
    "icon-circular",
  ];

  for (const variant of variants) {
    it(`snapshots the "${variant}" button structure/classes`, () => {
      const isIconCircular = variant === "icon-circular";
      const button = createButton({
        variant,
        label: "Get started",
        // icon-circular is inherently icon-only and requires an aria-label.
        ...(isIconCircular ? { ariaLabel: "Next slide", icon: "›" } : {}),
      });
      expect(button.outerHTML).toMatchSnapshot();
    });
  }

  it("primary button carries the Notion blue pill chrome (bg-primary/text-on-primary/rounded-full)", () => {
    const button = createButton({ variant: "primary", label: "Get started" });
    expect(button.className).toContain("bg-primary");
    expect(button.className).toContain("text-on-primary");
    expect(button.className).toContain("text-button");
    expect(button.className).toContain("rounded-full");
    // pressed state stays on the darker primary-active token.
    expect(button.className).toContain("active:bg-primary-active");
  });

  it("secondary button uses the white surface pill with the soft shadow", () => {
    const button = createButton({ variant: "secondary", label: "Request a demo" });
    expect(button.className).toContain("bg-surface");
    expect(button.className).toContain("text-ink");
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("shadow-soft");
  });

  it("utility button uses the tighter 8px radius and a hairline border", () => {
    const button = createButton({ variant: "utility", label: "Get Notion free" });
    expect(button.className).toContain("rounded-md");
    expect(button.className).toContain("border");
    expect(button.className).toContain("border-hairline");
    // utility deliberately never uses the pill radius reserved for CTAs.
    expect(button.className).not.toContain("rounded-full");
  });

  it("icon-circular button is a circular translucent control", () => {
    const button = createButton({
      variant: "icon-circular",
      ariaLabel: "Play",
      icon: "▶",
    });
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("size-9");
  });
});

describe("createButton — reserved focus ring & reduced motion (Req 20.3, 20.5)", () => {
  it("renders the reserved primary-blue focus-visible outline", () => {
    const button = createButton({ variant: "primary", label: "Focus me" });
    expect(button.className).toContain("focus-visible:outline-primary");
    expect(button.className).toContain("focus-visible:outline-2");
    expect(button.className).toContain("focus-visible:outline-offset-2");
  });

  it("gates press transitions behind motion-safe so reduced-motion is honored", () => {
    const button = createButton({ variant: "primary", label: "Press me" });
    expect(button.className).toContain("motion-safe:transition-transform");
    expect(button.className).toContain("motion-safe:active:scale-90");
  });
});

describe("createButton — accessibility / icon-only labels (Req 20.7)", () => {
  it("throws when an icon-only control is created without an ariaLabel", () => {
    expect(() => createButton({ iconOnly: true, icon: "✕" })).toThrow(
      /ariaLabel/,
    );
  });

  it("throws when the inherently icon-only icon-circular variant lacks an ariaLabel", () => {
    expect(() => createButton({ variant: "icon-circular", icon: "✕" })).toThrow(
      /ariaLabel/,
    );
  });

  it("reflects the ariaLabel to the aria-label attribute on icon-only controls", () => {
    const button = createButton({
      iconOnly: true,
      icon: "✕",
      ariaLabel: "Close",
    });
    expect(button.getAttribute("aria-label")).toBe("Close");
    // icon-only controls do not render the visible text label.
    expect(button.textContent).not.toContain("Close");
  });

  it("does not render label text for an icon-only control", () => {
    const button = createButton({
      iconOnly: true,
      label: "Should not show",
      ariaLabel: "Menu",
    });
    expect(button.textContent).not.toContain("Should not show");
  });
});

describe("createButton — disabled state", () => {
  it("applies the disabled attribute and the disabled treatment classes", () => {
    const button = createButton({
      variant: "primary",
      label: "Get started",
      disabled: true,
    });
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.className).toContain("disabled:opacity-50");
    expect(button.className).toContain("disabled:cursor-not-allowed");
  });
});

describe("createCard — Notion-token conformance snapshots (Req 20.1, 20.2)", () => {
  it("snapshots the flat card structure/classes", () => {
    const card = createCard({ variant: "flat", children: "Flat surface" });
    expect(card.outerHTML).toMatchSnapshot();
  });

  it("snapshots the elevated card structure/classes", () => {
    const card = createCard({ variant: "elevated", children: "Elevated surface" });
    expect(card.outerHTML).toMatchSnapshot();
  });

  it("flat card uses the white surface, 12px radius, 24px padding, hairline border", () => {
    const card = createCard({ variant: "flat" });
    expect(card.className).toContain("bg-surface");
    expect(card.className).toContain("text-ink");
    expect(card.className).toContain("rounded-lg");
    expect(card.className).toContain("p-lg");
    expect(card.className).toContain("border-hairline");
    // flat elevation is hairline-only, never a drop shadow.
    expect(card.className).not.toContain("acx-elevated");
  });

  it("elevated card adds the premium layered elevation (shadow + dark edge highlight)", () => {
    const card = createCard({ variant: "elevated" });
    expect(card.className).toContain("acx-elevated");
    // Elevated dialogs/menus sit on the slightly raised surface token.
    expect(card.className).toContain("bg-surface-raised");
  });
});

describe("createTextInput — Notion-token conformance snapshots (Req 20.1, 20.2)", () => {
  it("snapshots the text-input structure/classes", () => {
    const input = createTextInput({
      ariaLabel: "Search sites",
      placeholder: "example.com",
    });
    expect(input.outerHTML).toMatchSnapshot();
  });

  it("uses the tight 4px radius and hairline border (never the pill radius)", () => {
    const input = createTextInput({ ariaLabel: "Search sites" });
    expect(input.className).toContain("bg-surface");
    expect(input.className).toContain("text-ink");
    expect(input.className).toContain("rounded-xs");
    expect(input.className).toContain("border-hairline");
    expect(input.className).not.toContain("rounded-full");
  });
});

describe("createTextInput — reserved focus ring (Req 20.3, 20.5)", () => {
  it("renders the reserved primary-blue focus-visible outline and focus shadow", () => {
    const input = createTextInput({ ariaLabel: "Search sites" });
    expect(input.className).toContain("focus-visible:outline-primary");
    expect(input.className).toContain("focus-visible:outline-2");
    expect(input.className).toContain("focus-visible:outline-offset-2");
    expect(input.className).toContain("focus:shadow-soft");
  });
});

describe("createTextInput — accessibility / accessible name (Req 20.7)", () => {
  it("throws when neither ariaLabel nor labelledBy is provided", () => {
    expect(() => createTextInput({})).toThrow(/ariaLabel/);
  });

  it("reflects ariaLabel to the aria-label attribute", () => {
    const input = createTextInput({ ariaLabel: "Search sites" });
    expect(input.getAttribute("aria-label")).toBe("Search sites");
  });

  it("accepts a labelledBy association in place of an ariaLabel", () => {
    const input = createTextInput({ labelledBy: "search-label" });
    expect(input.getAttribute("aria-labelledby")).toBe("search-label");
    expect(input.hasAttribute("aria-label")).toBe(false);
  });
});

describe("createTextInput — disabled state", () => {
  it("applies the disabled attribute and the disabled treatment classes", () => {
    const input = createTextInput({ ariaLabel: "Search sites", disabled: true });
    expect(input.disabled).toBe(true);
    expect(input.hasAttribute("disabled")).toBe(true);
    expect(input.className).toContain("disabled:opacity-50");
    expect(input.className).toContain("disabled:cursor-not-allowed");
  });
});

describe("createBadge — Notion-token conformance snapshots (Req 20.1, 20.2, 20.3)", () => {
  it("snapshots the badge structure/classes", () => {
    const badge = createBadge({ label: "New" });
    expect(badge.outerHTML).toMatchSnapshot();
  });

  it("uses the white surface pill with primary-blue eyebrow text", () => {
    const badge = createBadge({ label: "New" });
    expect(badge.className).toContain("bg-surface");
    // the one place primary blue is used as a text accent (DESIGN.md badge-pill).
    expect(badge.className).toContain("text-primary");
    expect(badge.className).toContain("text-eyebrow");
    expect(badge.className).toContain("rounded-full");
  });
});

describe("joinClasses — class composition", () => {
  it("flattens, filters falsy values, and collapses whitespace", () => {
    expect(joinClasses("a", false, null, undefined, ["b", "c"], "  d  ")).toBe(
      "a b c d",
    );
  });

  it("appends caller className after the variant classes on a primitive", () => {
    const button = createButton({
      variant: "primary",
      label: "Custom",
      className: "mt-4",
    });
    expect(button.className.endsWith("mt-4")).toBe(true);
  });
});
