import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startChatQueueRunner } from "@/lib/chat-queue-runner";

/**
 * Boots the singleton background chat-queue runner on first mount of the
 * app shell. The runner drains queued chat messages for chats the user
 * is NOT currently viewing — see `lib/chat-queue-runner.ts` for the full
 * contract.
 *
 * Renders nothing; sits inside `QueryClientProvider` so the runner can
 * read / invalidate `chat(id)` rows via the same QueryClient the rest
 * of the app uses.
 *
 * StrictMode-safe: `startChatQueueRunner` is idempotent — a second
 * invocation (which Strict's double-mount triggers in dev) just rebinds
 * the QueryClient reference without registering duplicate subscriptions
 * or timers, so the runner stays a true singleton even through dev's
 * mount → unmount → mount cycle.
 *
 * Lives in its own file so `main.tsx` can stay component-only — the
 * `react-refresh/only-export-components` rule treats co-located
 * components + helpers as a HMR risk.
 */
export function ChatQueueRunnerBoot(): null {
  const qc = useQueryClient();
  useEffect(() => {
    return startChatQueueRunner(qc);
  }, [qc]);
  return null;
}
