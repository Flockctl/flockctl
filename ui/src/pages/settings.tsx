import { useState } from "react";
import { useAIKeys } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Plus,
  DollarSign,
  Server,
  Sliders,
} from "lucide-react";
import { ServerConnectionsList } from "@/components/server-connections";
import { SecretsPanel } from "@/components/secrets-panel";

import { CreateAIKeyDialog } from "./settings-components/CreateAIKeyDialog";
import { AIKeyTable } from "./settings-components/AIKeyTable";
import { DefaultsPanel } from "./settings-components/DefaultsPanel";
import { BudgetTable } from "./settings-components/BudgetTable";
import { CreateBudgetDialog } from "./settings-components/CreateBudgetDialog";
import { NotificationsTab } from "@/components/settings/notifications-tab";

import enLocale from "@/locales/en.json";

// --- Settings Page ---

export default function SettingsPage() {
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [createBudgetOpen, setCreateBudgetOpen] = useState(false);
  // Tab state lives in component memory only; the page is uncommon enough
  // that URL-syncing the tab isn't worth the wire-up complexity here.
  const [tab, setTab] = useState<"general" | "notifications">("general");

  const { data: aiKeys, isLoading: aiKeysLoading, error: aiKeysError } = useAIKeys();

  return (
    <div>
      <h1 className="text-xl font-bold sm:text-2xl">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground sm:text-base">
        Manage AI provider keys, budget limits, and notifications.
      </p>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "general" || value === "notifications") setTab(value);
        }}
        className="mt-6"
        data-testid="settings-tabs"
      >
        <TabsList className="self-start">
          <TabsTrigger value="general" data-testid="settings-tab-general">
            General
          </TabsTrigger>
          <TabsTrigger
            value="notifications"
            data-testid="settings-tab-notifications"
          >
            {enLocale.notifications.tab_label}
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="general"
          className="mt-4 space-y-8 data-[state=inactive]:hidden"
        >
          {/* Global Defaults */}
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Sliders className="h-5 w-5" />
              Defaults
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Default model and provider key used when a chat or project doesn&apos;t specify one.
              Stored in <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.flockctlrc</code>.
            </p>
            <div className="mt-4">
              <DefaultsPanel />
            </div>
          </div>

          {/* Server Connections */}
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Server className="h-5 w-5" />
              Server Connections
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect to remote Flockctl instances. Tokens are stored on the backend in{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.flockctlrc</code>{" "}
              (chmod 600) — never in the browser.
            </p>
            <div className="mt-4">
              <ServerConnectionsList />
            </div>
          </div>

          {/* AI Provider Keys */}
          <div>
            <h2 className="text-lg font-semibold">AI Provider Keys</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage API keys for AI providers. Keys are used for task execution and chat.
            </p>

            <div className="mt-4 space-y-4">
              <Button onClick={() => setCreateKeyOpen(true)}>
                <Plus className="mr-1 h-4 w-4" />
                Add Key
              </Button>

              <AIKeyTable keys={aiKeys} isLoading={aiKeysLoading} error={aiKeysError} />

              <CreateAIKeyDialog
                open={createKeyOpen}
                onOpenChange={setCreateKeyOpen}
              />
            </div>
          </div>

          {/* Global Secrets */}
          <div>
            <SecretsPanel scope="global" />
          </div>

          {/* Budget Limits */}
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Budget Limits
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Set spending limits to control AI costs. Limits can pause execution or show warnings.
            </p>

            <div className="mt-4 space-y-4">
              <Button onClick={() => setCreateBudgetOpen(true)}>
                <Plus className="mr-1 h-4 w-4" />
                Add Budget Limit
              </Button>

              <BudgetTable />

              <CreateBudgetDialog
                open={createBudgetOpen}
                onOpenChange={setCreateBudgetOpen}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent
          value="notifications"
          className="mt-4 data-[state=inactive]:hidden"
        >
          <NotificationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
