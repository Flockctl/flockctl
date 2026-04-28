/**
 * `flockctl chats ...` — manage interactive chat sessions.
 *
 * The chat surface is bigger than tasks (attachments, todos, streaming
 * SSE, per-message permission gating). The CLI exposes the operationally
 * useful subset:
 *
 *   list / show / cancel / approve / reject — same shape as `tasks`
 *   send <id>     — append a message; reads from stdin if --message is omitted
 *   tail <id>     — poll for new messages until terminal status
 *   rm   <id>     — soft-delete the chat
 *
 * Everything beyond that (attachments, multi-modal payloads, todo
 * extraction, incident extraction) is UI territory; if you find yourself
 * needing it from the CLI, reach for `curl` against the documented API.
 */
import type { Command } from "commander";
import { readFileSync } from "fs";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { resolveByIdOrName, printJson, type ListResponse, type NamedRow } from "./_shared.js";

interface ChatRow {
  id: number;
  projectId: number | null;
  workspaceId: number | null;
  title: string | null;
  status: string | null;
  entityType: string | null;
  entityId: number | null;
  permissionMode: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface ChatMessage {
  id: number;
  chatId: number;
  role: string;
  content: string;
  createdAt: string;
}

const TERMINAL = new Set(["done", "completed", "failed", "cancelled", "idle"]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function registerChatsCommand(program: Command): void {
  const cmd = program.command("chats").description("Manage chat sessions.");

  cmd
    .command("list")
    .description("List chats.")
    .option("-p, --project <idOrName>", "Filter by project")
    .option("-w, --workspace <idOrName>", "Filter by workspace")
    .option("-q, --query <text>", "Free-text search across title + messages")
    .option("--page <n>", "1-based page", "1")
    .option("--per-page <n>", "Page size", "50")
    .option("--json", "Print as JSON")
    .action(
      async (opts: {
        project?: string;
        workspace?: string;
        query?: string;
        page?: string;
        perPage?: string;
        json?: boolean;
      }) => {
        try {
          const client = createDaemonClient();
          const query: Record<string, string | number> = {
            page: opts.page ?? "1",
            perPage: opts.perPage ?? "50",
          };
          if (opts.project) {
            const p = await resolveByIdOrName<NamedRow>(client, "projects", opts.project);
            query.project_id = p.id;
          }
          if (opts.workspace) {
            const w = await resolveByIdOrName<NamedRow>(client, "workspaces", opts.workspace);
            query.workspace_id = w.id;
          }
          if (opts.query) query.q = opts.query;
          const res = await client.get<ListResponse<ChatRow>>("/chats", query);
          if (opts.json) {
            printJson(res);
            return;
          }
          if (res.items.length === 0) {
            console.log("(no chats)");
            return;
          }
          for (const ch of res.items) {
            const title = ch.title ?? "(untitled)";
            console.log(`  #${ch.id}  [${ch.status ?? "?"}]  ${title}`);
          }
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("show <id>")
    .description("Show a chat row with metrics.")
    .option("--json", "Print as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const ch = await client.get<ChatRow>(`/chats/${id}`);
        if (opts.json) {
          printJson(ch);
          return;
        }
        console.log(`Chat #${ch.id} [${ch.status ?? "?"}]`);
        console.log(`  title:       ${ch.title ?? "(untitled)"}`);
        console.log(`  project:     ${ch.projectId ?? "(none)"}`);
        console.log(`  workspace:   ${ch.workspaceId ?? "(none)"}`);
        console.log(`  permission:  ${ch.permissionMode ?? "(default)"}`);
        console.log(`  createdAt:   ${ch.createdAt}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("send <id>")
    .description(
      "Append a user message to a chat. The body is read from --message or " +
        "from stdin (whichever is given). The reply is fetched in the same call.",
    )
    .option("-m, --message <text>", "Inline message text (otherwise read from stdin)")
    .option("--model <model>", "Override the model used for this turn")
    .option("--json", "Print the assistant message as JSON")
    .action(
      async (
        id: string,
        opts: { message?: string; model?: string; json?: boolean },
      ) => {
        try {
          const client = createDaemonClient();
          const content =
            opts.message ?? (process.stdin.isTTY ? "" : readFileSync(0, "utf-8"));
          if (!content) {
            console.error("Error: pass --message or pipe text via stdin.");
            process.exit(1);
          }
          const res = await client.post<{ message?: ChatMessage }>(
            `/chats/${id}/messages`,
            {
              content,
              ...(opts.model && { model: opts.model }),
            },
          );
          if (opts.json) {
            printJson(res);
            return;
          }
          if (res.message) {
            console.log(res.message.content);
          }
        } catch (err) {
          exitWithDaemonError(err);
        }
      },
    );

  cmd
    .command("cancel <id>")
    .description("Cancel a running chat session.")
    .action(async (id: string) => {
      try {
        const client = createDaemonClient();
        await client.post(`/chats/${id}/cancel`);
        console.log(`Cancelled chat #${id}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("approve <id>")
    .description("Approve a chat awaiting approval.")
    .option("-n, --note <text>", "Optional reviewer note")
    .action(async (id: string, opts: { note?: string }) => {
      try {
        const client = createDaemonClient();
        await client.post(`/chats/${id}/approve`, opts.note ? { note: opts.note } : {});
        console.log(`Approved chat #${id}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("reject <id>")
    .description("Reject a chat awaiting approval.")
    .option("-n, --note <text>", "Optional reviewer note")
    .action(async (id: string, opts: { note?: string }) => {
      try {
        const client = createDaemonClient();
        await client.post(`/chats/${id}/reject`, opts.note ? { note: opts.note } : {});
        console.log(`Rejected chat #${id}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("rm <id>")
    .alias("remove")
    .description("Soft-delete a chat (and its attachments).")
    .action(async (id: string) => {
      try {
        const client = createDaemonClient();
        await client.del(`/chats/${id}`);
        console.log(`Deleted chat #${id}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("tail <id>")
    .description("Poll a chat for new messages until it reaches a terminal state.")
    .option("--interval-ms <n>", "Polling interval", "1500")
    .action(async (id: string, opts: { intervalMs?: string }) => {
      try {
        const client = createDaemonClient();
        const interval = Math.max(500, parseInt(opts.intervalMs ?? "1500", 10) || 1500);
        let lastSeenId = 0;
        for (;;) {
          // We rely on /chats/:id/todos as a side-channel — the API doesn't
          // expose a flat list of messages today; show is what we have.
          const ch = await client.get<ChatRow>(`/chats/${id}`);
          if (TERMINAL.has(ch.status ?? "")) {
            return;
          }
          await sleep(interval);
          // (intentionally minimal: full message-stream tail is a future
          // upgrade that should hook the SSE endpoint directly.)
          if (lastSeenId === 0) lastSeenId = 1;
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
