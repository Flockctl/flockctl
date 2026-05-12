import * as React from "react";
import { ConnectionBanner } from "@/components/connection-banner";
import { AttentionNotificationsRunner } from "@/lib/hooks/use-attention-notifications";
import { ChatReplyNotificationsRunner } from "@/lib/hooks/use-chat-reply-notifications";
import { NotificationClickRouterRunner } from "@/lib/hooks/use-notification-click-router";
import { TaskTerminalNotificationsRunner } from "@/lib/hooks/use-task-terminal-notifications";
import { TitleBar } from "@/components/shell/TitleBar";
import { Sidebar } from "@/components/shell/Sidebar";
import { CmdK } from "@/components/palette/CmdK";
import { cmdkStore } from "@/components/palette/cmdk-store";

/**
 * NewShell — the next-gen chrome introduced in M17.
 *
 * Three slots, top to bottom:
 *   - `<TitleBar />`  — slice 01 (logo + dynamic breadcrumb + ⌘K
 *                        placeholder + server-switcher + connection
 *                        dot + theme toggle).
 *   - `<Sidebar />`   — slice 02 (Recent + Browse + reused
 *                        SidebarFooter).
 *   - `<main>`        — the route outlet, identical to old layout.
 *
 * The four notification-pump runners (attention, task-terminal,
 * chat-reply, notification-click router) MUST stay mounted whenever
 * the app is alive — they're the OS-notification fan-out and live
 * here at the same depth they used to live in the legacy shell so
 * the per-tab WebSocket baseline behaves identically.
 *
 * `<ConnectionBanner />` mounts here too. The disconnected/error
 * states keep their banner; the title-bar dot is a redundant always-
 * visible signal, not a replacement.
 */
export function NewShell({ children }: { children: React.ReactNode }) {
  // ⌘K / Ctrl+K global toggle. Mounted once at the shell layer so it
  // survives every navigation. Skipped while the user is typing into
  // an input or contenteditable surface so the shortcut doesn't
  // hijack ⌘K inside a text editor.
  React.useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (target.isContentEditable) return true;
      return false;
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        cmdkStore.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onCmdK = React.useCallback(() => cmdkStore.open(), []);

  return (
    <div className="flex h-screen min-h-0 flex-col" data-shell="next">
      {/*
        Notification pumps — these MUST stay mounted whenever the app
        is alive; they fan WS frames out to the OS notification API.
        Order is preserved from the legacy layout so the per-runner
        diff baselines (kept as React refs) settle identically.
      */}
      <AttentionNotificationsRunner />
      <TaskTerminalNotificationsRunner />
      <ChatReplyNotificationsRunner />
      <NotificationClickRouterRunner />

      <TitleBar onCmdK={onCmdK} />

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <ConnectionBanner />
          <main className="flex-1 min-h-0 overflow-auto p-3 sm:p-4 md:p-6">
            {children}
          </main>
        </div>
      </div>

      {/* Global command palette overlay — mounted once at the shell
          layer so any descendant can summon it via cmdkStore.open(). */}
      <CmdK />
    </div>
  );
}

export default NewShell;
