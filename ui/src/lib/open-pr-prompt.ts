/**
 * Boilerplate prompt the "Open PR" button drops into the chat queue.
 * The agent picks it up next time it's idle and runs the steps below.
 *
 * Critically: the prompt asks the agent to NOT auto-commit unrelated
 * drift, NOT bypass commit hooks, and NOT force-push. Those defaults
 * matter — without them an agent following the path of least
 * resistance can corrupt the operator's branch state in ways that are
 * tedious to recover from.
 *
 * `extraContext` (optional) is appended as a "Context from the
 * operator" section so the user can hint at issue numbers, target
 * reviewers, scope nuances, etc. Empty / whitespace-only context is
 * dropped — the section header would otherwise float in the prompt
 * with no body.
 *
 * Lives in its own module (rather than inline in `chats.tsx`) so the
 * prompt's invariants — the hard rules, the title cap, the body
 * shape — can be unit-tested without dragging the entire chats page
 * into the test harness.
 */
export function buildOpenPrPrompt(extraContext: string): string {
  const context = extraContext.trim();
  const parts: string[] = [
    "Open a pull request for the work in this chat.",
    "",
    "Steps:",
    "1. Verify state — `git rev-parse --abbrev-ref HEAD`, `git status --short`, `git log --oneline -10`.",
    "2. If there are uncommitted changes that belong to this chat's work, commit them with a tight subject + body. If you see drift you don't recognise, ASK ME before committing — don't auto-commit unrelated changes.",
    "3. Push the branch: `git push -u origin HEAD`. Do NOT force-push.",
    "4. Open the PR with `gh pr create`. Do NOT pass `--no-edit` — fill the title/body explicitly:",
    "   - Title: short imperative summary, under 70 characters. No emoji.",
    "   - Body, in this exact shape:",
    "     ## Summary",
    "     <1–3 bullets describing what changed and WHY>",
    "",
    "     ## Test plan",
    "     - [ ] <how to verify>",
    "     - [ ] <add more checkboxes for each affected surface>",
    "5. Reply with the PR URL.",
    "",
    "Hard rules: never skip commit hooks (`--no-verify`), never bypass GPG signing, never force-push, never amend an existing commit unless I explicitly ask.",
  ];
  if (context.length > 0) {
    parts.push("", "Context from the operator:", context);
  }
  return parts.join("\n");
}
