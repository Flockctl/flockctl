import { EventEmitter } from "events";

interface WSClient {
  send(data: string): void;
  readyState: number;
}

class WSManager extends EventEmitter {
  private taskClients = new Map<number, Set<WSClient>>();
  private chatClients = new Map<number, Set<WSClient>>();
  private globalChatClients = new Set<WSClient>();
  private allClients = new Set<WSClient>();

  addTaskClient(taskId: number, ws: WSClient) {
    let set = this.taskClients.get(taskId);
    if (!set) {
      set = new Set();
      this.taskClients.set(taskId, set);
    }
    set.add(ws);
    this.allClients.add(ws);
  }

  addChatClient(chatId: number, ws: WSClient) {
    let set = this.chatClients.get(chatId);
    if (!set) {
      set = new Set();
      this.chatClients.set(chatId, set);
    }
    set.add(ws);
    this.allClients.add(ws);
  }

  addGlobalChatClient(ws: WSClient) {
    this.globalChatClients.add(ws);
    this.allClients.add(ws);
  }

  removeClient(ws: WSClient) {
    for (const [taskId, set] of this.taskClients) {
      if (set.delete(ws) && set.size === 0) this.taskClients.delete(taskId);
    }
    for (const [chatId, set] of this.chatClients) {
      if (set.delete(ws) && set.size === 0) this.chatClients.delete(chatId);
    }
    this.globalChatClients.delete(ws);
    this.allClients.delete(ws);
  }

  broadcast(taskId: number, data: Record<string, unknown>) {
    const set = this.taskClients.get(taskId);
    if (!set || set.size === 0) return;
    const msg = JSON.stringify({ ...data, taskId });
    this._send(set, msg);
  }

  broadcastChat(chatId: number, data: Record<string, unknown>) {
    const msg = JSON.stringify({ ...data, chatId });
    const scoped = this.chatClients.get(chatId);
    if (scoped && scoped.size > 0) this._send(scoped, msg);
    if (this.globalChatClients.size > 0) this._send(this.globalChatClients, msg);
  }

  broadcastAll(data: Record<string, unknown>) {
    if (this.allClients.size === 0) return;
    const msg = JSON.stringify(data);
    this._send(this.allClients, msg);
  }

  private _send(clients: Iterable<WSClient>, msg: string) {
    for (const client of clients) {
      if (client.readyState === 1) {
        try { client.send(msg); } catch { /* dead socket */ }
      }
    }
  }

  get clientCount(): number {
    return this.allClients.size;
  }

  closeAll(): void {
    for (const client of this.allClients) {
      try {
        if (client.readyState === 1 && typeof (client as any).close === "function") {
          (client as any).close();
        }
      } catch { /* ignore */ }
    }
    this.taskClients.clear();
    this.chatClients.clear();
    this.globalChatClients.clear();
    this.allClients.clear();
  }
}

export const wsManager = new WSManager();
