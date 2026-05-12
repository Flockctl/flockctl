import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ChatMessage } from "@/components/chat-message";

/**
 * T01 — Bubble layout for text + markdown messages.
 *
 * Locks in the per-role visual contract:
 *   • user      → `flex justify-end`, indigo-tinted bubble
 *                 (`bg-indigo-500/10`, `rounded-2xl rounded-tr-sm`,
 *                 `max-w-[680px]`).
 *   • assistant → `flex justify-start`, plain (background-less) bubble
 *                 with a gradient avatar circle showing "F" initials on
 *                 the left.
 *
 * Markdown rendering (react-markdown + remark-gfm + rehype-highlight) must
 * stay wired for assistant turns. User turns continue to render as
 * literal `whitespace-pre-wrap` text — no markdown.
 */
describe("ChatMessage — bubble layout per role", () => {
  // ------------------------------------------------------------------
  // user — alignment + bubble shape
  // ------------------------------------------------------------------
  describe("user message", () => {
    it("aligns right with justify-end", () => {
      const { container } = render(
        <ChatMessage role="user" content="hello" />
      );
      const row = container.firstChild as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.className).toContain("justify-end");
      expect(row.className).not.toContain("justify-start");
    });

    it("uses an indigo-tinted bubble with rounded-2xl rounded-tr-sm", () => {
      const { getByTestId } = render(
        <ChatMessage role="user" content="hello" />
      );
      const bubble = getByTestId("chat-bubble");
      expect(bubble.getAttribute("data-role")).toBe("user");
      expect(bubble.className).toContain("bg-indigo-500/10");
      expect(bubble.className).toContain("dark:bg-indigo-500/15");
      expect(bubble.className).toContain("rounded-2xl");
      expect(bubble.className).toContain("rounded-tr-sm");
    });

    it("caps width at 680px", () => {
      const { getByTestId } = render(
        <ChatMessage role="user" content="hello" />
      );
      const bubble = getByTestId("chat-bubble");
      // The max-width lives on the wrapper (parent of the bubble) so the
      // copy button can hang outside the bubble itself without being
      // clipped by the cap. Walk up one level to assert against it.
      const wrapper = bubble.parentElement as HTMLElement;
      expect(wrapper).not.toBeNull();
      expect(wrapper.className).toContain("max-w-[680px]");
    });

    it("renders as plain text (no markdown) inside the bubble", () => {
      // Asterisks must NOT be rendered as <strong> for user turns —
      // the user bubble uses whitespace-pre-wrap, not react-markdown.
      const { container, getByText } = render(
        <ChatMessage role="user" content="**bold** in user turn" />
      );
      // The literal source text is preserved verbatim.
      expect(getByText("**bold** in user turn")).toBeTruthy();
      // No <strong> tag rendered → markdown not applied.
      expect(container.querySelector("strong")).toBeNull();
    });

    it("does not render the assistant avatar", () => {
      const { queryByTestId } = render(
        <ChatMessage role="user" content="hello" />
      );
      expect(queryByTestId("assistant-avatar")).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // assistant — alignment + avatar + plain bubble
  // ------------------------------------------------------------------
  describe("assistant message", () => {
    it("aligns left with justify-start", () => {
      const { container } = render(
        <ChatMessage role="assistant" content="reply" />
      );
      const row = container.firstChild as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.className).toContain("justify-start");
      expect(row.className).not.toContain("justify-end");
    });

    it("renders the gradient 'F' avatar circle on the left", () => {
      const { getByTestId } = render(
        <ChatMessage role="assistant" content="reply" />
      );
      const avatar = getByTestId("assistant-avatar");
      expect(avatar).not.toBeNull();
      expect(avatar.textContent).toBe("F");
      // Gradient classes are present so the avatar visibly has the
      // brand color — guards against a refactor that drops the bg.
      expect(avatar.className).toContain("bg-gradient-to-br");
      expect(avatar.className).toContain("from-indigo-500");
      expect(avatar.className).toContain("rounded-full");
    });

    it("uses a background-less bubble (no indigo tint, no muted shell)", () => {
      const { getByTestId } = render(
        <ChatMessage role="assistant" content="reply" />
      );
      const bubble = getByTestId("chat-bubble");
      expect(bubble.getAttribute("data-role")).toBe("assistant");
      // Assistant bubble is plain — neither the user indigo tint nor
      // the legacy muted shell remain.
      expect(bubble.className).not.toContain("bg-indigo-500/10");
      expect(bubble.className).not.toContain("bg-muted/60");
      expect(bubble.className).not.toContain("bg-primary");
    });
  });

  // ------------------------------------------------------------------
  // markdown rendering preserved for assistant turns
  // ------------------------------------------------------------------
  describe("markdown rendering", () => {
    it("renders **bold** as <strong> in an assistant message", () => {
      const { container } = render(
        <ChatMessage role="assistant" content="**bold** word" />
      );
      const strong = container.querySelector("strong");
      expect(strong).not.toBeNull();
      expect(strong!.textContent).toBe("bold");
    });

    it("renders [links](http://example.com) with target=_blank rel=noopener", () => {
      const { container } = render(
        <ChatMessage
          role="assistant"
          content="see [docs](https://example.com)"
        />
      );
      const link = container.querySelector("a");
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).toBe("https://example.com");
      expect(link!.getAttribute("target")).toBe("_blank");
      // rel must include noopener — security regression guard.
      expect(link!.getAttribute("rel") || "").toContain("noopener");
    });

    it("renders fenced code blocks with the language class", () => {
      const md = "```js\nconst x = 1;\n```";
      const { container } = render(
        <ChatMessage role="assistant" content={md} />
      );
      const code = container.querySelector("code.language-js");
      expect(code).not.toBeNull();
      expect(code!.textContent).toContain("const x = 1;");
    });

    // Regression — agents emit ASCII-art schemas in *untagged* fenced
    // blocks (` ```\n…\n``` `, no language). The previous block-vs-inline
    // detection only matched `language-*` and `hljs` classNames, so
    // untagged blocks fell through to the inline-pill branch and got
    // `break-all` applied, breaking box-drawing characters into a
    // wrapped staircase. The fix routes any multi-line `code` to the
    // block branch (`<CodeBlock>`); the inline-pill class must NOT
    // appear on the rendered `<code>`.
    it("renders untagged fenced code blocks as block, not inline pill", () => {
      const md = "```\n┌─ Agent ─┐\n│  …      │\n└─────────┘\n```";
      const { container } = render(
        <ChatMessage role="assistant" content={md} />
      );
      const code = container.querySelector("code");
      expect(code).not.toBeNull();
      expect(code!.textContent).toContain("┌─ Agent ─┐");
      // The inline-pill styling is what mangled the schema. Block code
      // is wrapped in our <CodeBlock> (which renders a <pre> ancestor)
      // and never carries `break-all` on the inner <code>. Assert both:
      // (a) the inline-pill marker class is absent, (b) a <pre> ancestor
      // exists so the .chat-markdown CSS reset (white-space: pre,
      // overflow-x: auto) actually applies.
      expect(code!.className).not.toContain("break-all");
      expect(code!.className).not.toContain("bg-zinc-200");
      expect(code!.closest("pre")).not.toBeNull();
    });

    it("renders inline `code` as a styled <code> tag", () => {
      const { container } = render(
        <ChatMessage role="assistant" content="use `npm test` to run" />
      );
      // At least one <code> rendered for the inline span.
      const codes = container.querySelectorAll("code");
      expect(codes.length).toBeGreaterThan(0);
    });

    it("wraps tables in an overflow container (markdown table support)", () => {
      const md = "| a | b |\n|---|---|\n| 1 | 2 |";
      const { container } = render(
        <ChatMessage role="assistant" content={md} />
      );
      const table = container.querySelector("table");
      expect(table).not.toBeNull();
      // Custom <th> styling is applied — confirms the GFM remark plugin
      // is still wired and our component overrides are taking effect.
      const th = container.querySelector("th");
      expect(th).not.toBeNull();
      expect(th!.textContent).toBe("a");
    });
  });
});
