import { useState, useEffect, useRef } from "react";
import { useCreateChat, useEntityChat } from "@/lib/hooks";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatConversation } from "@/components/chat-conversation";
import { X, Loader2 } from "lucide-react";
import type { ChatContext } from "./types";

// --- Plan Chat Panel ---

export function PlanChatPanel({
  projectId,
  context,
  onClose,
}: {
  projectId: string;
  context: ChatContext;
  onClose: () => void;
}) {
  // Resolve the entity-scoped chat: fetch existing one (or `null`), then lazily
  // create it via the unified `POST /chats` endpoint. Backend enforces idempotency
  // on (project_id, entity_type, entity_id) so concurrent tabs converge safely.
  //
  // This component is remounted (via `key`) whenever context entity changes, so
  // we don't need to reset chatId / streaming state on context change — the whole
  // component tree is thrown away and rebuilt.
  const {
    data: entityChat,
    isFetching: entityChatFetching,
  } = useEntityChat(projectId, context.entity_type, context.entity_id);
  const createChatMutation = useCreateChat();
  const [createdChatId, setCreatedChatId] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const chatId = entityChat?.id ?? createdChatId;

  useEffect(() => {
    if (chatId) return;
    if (entityChatFetching) return;
    if (entityChat !== null) return;
    if (creatingRef.current) return;
    creatingRef.current = true;
    createChatMutation
      .mutateAsync({
        projectId: parseInt(projectId),
        entityType: context.entity_type,
        entityId: context.entity_id,
      })
      .then((chat) => {
        setCreatedChatId(chat.id);
      })
      .finally(() => {
        creatingRef.current = false;
      });
  }, [
    chatId,
    entityChat,
    entityChatFetching,
    projectId,
    context.entity_type,
    context.entity_id,
    createChatMutation,
  ]);

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b p-3">
        <Badge variant="outline" className="text-xs capitalize">{context.entity_type}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{context.title}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ChatConversation
        chatId={chatId}
        composerDisabled={!chatId}
        projectIdForStream={projectId}
        entityContext={{
          entity_type: context.entity_type,
          entity_id: context.entity_id,
          milestone_id: context.milestone_id,
          slice_id: context.slice_id,
        }}
        placeholder={`Ask about this ${context.entity_type}...`}
        emptyState={
          !chatId ? (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Creating chat&hellip;</span>
            </div>
          ) : undefined
        }
      />
    </Card>
  );
}
