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

  it("primary button carries the arcade CTA chrome (indigo fill/white text/pill/shadow)", () => {
    const button = createButton({ variant: "primary", label: "Get started" });
    expect(button.className).toContain("bg-[#4503ff]");
    // Bold brand fill carries white text.
    expect(button.className).toContain("text-white");
    expect(button.className).toContain("text-button");
    // Pill geometry with the thick black border + hard-offset shadow.
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("border-hairline");
    expect(button.className).toContain("acx-btn-shadow");
  });

  it("secondary button uses the violet brand fill with the pill geometry", () => {
    const button = createButton({ variant: "secondary", label: "Request a demo" });
    expect(button.className).toContain("bg-[#9747ff]");
    expect(button.className).toContain("text-white");
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("acx-btn-shadow");
  });

  it("utility button uses the coral brand fill, squared radius and a strong hairline border", () => {
    const button = createButton({ variant: "utility", label: "Get started free" });
    expect(button.className).toContain("bg-[#ff5555]");
    expect(button.className).toContain("rounded-md");
    expect(button.className).toContain("border-2");
    expect(button.className).toContain("border-hairline-strong");
    // utility deliberately never uses the pill geometry.
    expect(button.className).not.toContain("rounded-full");
  });

  it("icon-circular button is a circular bordered arcade control", () => {
    const button = createButton({
      variant: "icon-circular",
      ariaLabel: "Play",
      icon: "▶",
    });
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("size-9");
    expect(button.className).toContain("acx-btn-shadow");
  });
});

describe("createButton — reserved focus ring & reduced motion (Req 20.3, 20.5)", () => {
  it("renders the reserved brand-accent focus-visible outline", () => {
    const button = createButton({ variant: "primary", label: "Focus me" });
    expect(button.className).toContain("focus-visible:outline-primary");
    expect(button.className).toContain("focus-visible:outline-2");
    expect(button.className).toContain("focus-visible:outline-offset-2");
  });

  it("carries the brutalist press-into-shadow interaction class", () => {
    const button = createButton({ variant: "primary", label: "Press me" });
    // The press motion + active state live in `.acx-btn` (motion gated in CSS).
    expect(button.className).toContain("acx-btn");
    expect(button.className).toContain("acx-btn-shadow");
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
    expect(card.className).toContain("p-md");
    expect(card.className).toContain("border-hairline");
    // flat elevation is hairline-only, never a drop shadow.
    expect(card.className).not.toContain("acx-elevated");
  });

  it("elevated card uses the premium translucent glass surface + entrance", () => {
    const card = createCard({ variant: "elevated" });
    // Elevated dialogs/menus use the translucent "glass" surface (backdrop blur
    // + page show-through) with a soft scale+lift entrance.
    expect(card.className).toContain("acx-glass");
    expect(card.className).toContain("acx-enter");
    // The opaque flat surface fill is not applied to the glass variant.
    expect(card.className).not.toContain("bg-surface ");
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

  it("uses the 12px radius and ink hairline border (never the CTA pill radius)", () => {
    const input = createTextInput({ ariaLabel: "Search sites" });
    expect(input.className).toContain("bg-surface");
    expect(input.className).toContain("text-ink");
    expect(input.className).toContain("rounded-md");
    expect(input.className).toContain("border-hairline-strong");
    expect(input.className).not.toContain("rounded-xl");
  });
});

describe("createTextInput — reserved focus ring (Req 20.3, 20.5)", () => {
  it("renders the reserved brand-accent focus-visible outline", () => {
    const input = createTextInput({ ariaLabel: "Search sites" });
    expect(input.className).toContain("focus-visible:outline-primary");
    expect(input.className).toContain("focus-visible:outline-2");
    expect(input.className).toContain("focus-visible:outline-offset-2");
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

  it("uses the soft-green pill with positive-deep eyebrow text (Wise positive badge)", () => {
    const badge = createBadge({ label: "New" });
    expect(badge.className).toContain("bg-primary-pale");
    expect(badge.className).toContain("text-positive-deep");
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
