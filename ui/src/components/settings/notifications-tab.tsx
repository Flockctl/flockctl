import { useEffect, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Bell, ShieldAlert, ShieldOff, Slash, Users, UserCheck } from "lucide-react";

import {
  type NotificationPrefs,
  useNotificationPrefs,
} from "@/lib/notification-prefs";
import {
  type PermissionStatus,
  getStatus,
  requestPermission,
  subscribePermissionChange,
} from "@/lib/notification-permission";
import { useLeaderStatus } from "@/lib/contexts/notification-dispatcher-context";

import enLocale from "@/locales/en.json";

/**
 * Settings → Notifications tab.
 *
 * Surfaces two pieces of state:
 *   1. The browser-level Notification permission (granted/denied/default,
 *      plus the unusable "unsupported" / "insecure-context" sentinels).
 *   2. The user's saved preferences (master switch + 5 categories).
 *
 * Multi-tab dedup is handled invisibly by the LeaderElection wired in
 * `notification-dispatcher-context.tsx`: only the leader tab's dispatcher
 * actually fires, follower tabs short-circuit at the leader gate. The
 * <LeaderStatusRow /> below surfaces which tab is currently the leader.
 *
 * Permission and prefs are decoupled on purpose. Toggling the master switch
 * OFF leaves the browser permission alone (so re-enabling later doesn't
 * re-prompt). Revoking permission via the browser's site-settings UI flips
 * the row through `subscribePermissionChange` without a reload, and the
 * category fieldset hides itself because its gate is `prefs.enabled &&
 * permStatus === "granted"`.
 *
 * `requestPermission()` is only ever called from the master-toggle click
 * handler — never from `useEffect`. Some browser configurations reject a
 * permission prompt that isn't tied to a fresh user gesture.
 */

const t = enLocale.notifications;

export function NotificationsTab(): React.JSX.Element {
  const [prefs, setPrefs] = useNotificationPrefs();
  // Seed from the live status so the first paint matches reality (avoids a
  // "flicker from default → granted" on tabs that already have permission).
  const [permStatus, setPermStatus] = useState<PermissionStatus>(() =>
    getStatus(),
  );

  useEffect(() => subscribePermissionChange(setPermStatus), []);

  if (permStatus === "insecure-context") {
    return (
      <Banner
        icon={<Slash className="h-4 w-4" aria-hidden="true" />}
        message={t.banner.insecure_context}
        testid="notifications-banner-insecure-context"
      />
    );
  }
  if (permStatus === "unsupported") {
    return (
      <Banner
        icon={<ShieldOff className="h-4 w-4" aria-hidden="true" />}
        message={t.banner.unsupported}
        testid="notifications-banner-unsupported"
      />
    );
  }

  const onMasterToggle = async (next: boolean) => {
    if (next && permStatus === "default") {
      // User-gesture path. `requestPermission` short-circuits when the
      // current status is already granted/denied, so this only prompts
      // when there's something to ask.
      const result = await requestPermission();
      setPermStatus(result);
      if (result !== "granted") return; // don't flip prefs.enabled if denied
    }
    setPrefs({ ...prefs, enabled: next });
  };

  const setCategory =
    (key: Exclude<keyof NotificationPrefs, "enabled">) =>
    (value: boolean | "indeterminate") => {
      // Radix Checkbox can emit an "indeterminate" tri-state — coerce to
      // boolean since our schema is strictly bool.
      setPrefs({ ...prefs, [key]: value === true });
    };

  return (
    <div className="space-y-6" data-testid="notifications-tab">
      <PermissionStatusRow status={permStatus} />
      <LeaderStatusRow />

      <div className="flex items-center gap-3">
        <Checkbox
          id="notifications-master"
          checked={prefs.enabled}
          onCheckedChange={(value) => {
            void onMasterToggle(value === true);
          }}
          data-testid="notifications-master-toggle"
        />
        <Label htmlFor="notifications-master">{t.master}</Label>
      </div>

      {prefs.enabled && permStatus === "granted" && (
        <fieldset className="space-y-3 rounded-md border border-input p-4">
          <legend className="px-1 text-xs font-medium text-muted-foreground">
            {t.master}
          </legend>
          <CategoryRow
            id="notif-cat-approval"
            label={t.cat.approval}
            checked={prefs.onApprovalNeeded}
            onChange={setCategory("onApprovalNeeded")}
            testid="notifications-cat-approval"
          />
          <CategoryRow
            id="notif-cat-question"
            label={t.cat.question}
            checked={prefs.onQuestionAsked}
            onChange={setCategory("onQuestionAsked")}
            testid="notifications-cat-question"
          />
          <CategoryRow
            id="notif-cat-done"
            label={t.cat.done}
            checked={prefs.onTaskDone}
            onChange={setCategory("onTaskDone")}
            testid="notifications-cat-done"
          />
          <CategoryRow
            id="notif-cat-failed"
            label={t.cat.failed}
            checked={prefs.onTaskFailed}
            onChange={setCategory("onTaskFailed")}
            testid="notifications-cat-failed"
          />
          <CategoryRow
            id="notif-cat-blocked"
            label={t.cat.blocked}
            checked={prefs.onTaskBlocked}
            onChange={setCategory("onTaskBlocked")}
            testid="notifications-cat-blocked"
          />
          {/*
           * Slice 01 of M15: chat-reply row. Unlike the four task rows above,
           * this category ships with a description string (the desired-reply
           * use-case is less self-evident than "task failed") — rendered as a
           * small muted line below the <Label>. We keep the existing
           * <CategoryRow> helper untouched (per slice rule "do not refactor
           * the existing four rows") and inline the layout for this one row.
           */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="notif-cat-chatreply"
              checked={prefs.onChatReply}
              onCheckedChange={setCategory("onChatReply")}
              data-testid="notifications-cat-chatreply"
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor="notif-cat-chatreply">{t.chatReply.label}</Label>
              <p
                className="text-xs text-muted-foreground"
                data-testid="notifications-cat-chatreply-description"
              >
                {t.chatReply.description}
              </p>
            </div>
          </div>
        </fieldset>
      )}

      {permStatus === "denied" && (
        <Banner
          icon={<ShieldAlert className="h-4 w-4" aria-hidden="true" />}
          message={t.banner.denied_recovery}
          testid="notifications-banner-denied"
        />
      )}
    </div>
  );
}

interface CategoryRowProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean | "indeterminate") => void;
  testid: string;
}

function CategoryRow({
  id,
  label,
  checked,
  onChange,
  testid,
}: CategoryRowProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        data-testid={testid}
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

function LeaderStatusRow(): React.JSX.Element {
  // The leader status row is purely informational — no toggle, no action.
  // Election is automatic; the user cannot opt in/out of being the leader.
  // We surface it so that when a user wonders "why didn't this tab beep?"
  // the answer is one glance away in Settings.
  const status = useLeaderStatus();
  const label =
    status === "leader"
      ? t.leader.status_leader
      : t.leader.status_follower;
  const Icon = status === "leader" ? UserCheck : Users;
  return (
    <div
      className="flex items-center gap-2 text-sm text-muted-foreground"
      aria-live="polite"
      data-testid="notifications-leader-status"
      data-leader={status}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function PermissionStatusRow({
  status,
}: {
  status: PermissionStatus;
}): React.JSX.Element {
  // Only the three real states ever land here — "unsupported" and
  // "insecure-context" are handled by early-return banners above.
  const label =
    status === "granted"
      ? t.permission.granted
      : status === "denied"
        ? t.permission.denied
        : t.permission.default;

  // `aria-live="polite"` so the row reads itself out when permission flips
  // mid-session (e.g. the user revokes via the address-bar UI).
  return (
    <div
      className="flex items-center gap-2 text-sm text-muted-foreground"
      aria-live="polite"
      data-testid="notifications-permission-status"
      data-permission={status}
    >
      <Bell className="h-4 w-4" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

interface BannerProps {
  icon: React.ReactNode;
  message: string;
  testid: string;
}

function Banner({ icon, message, testid }: BannerProps): React.JSX.Element {
  // Banners stand in for the entire UI when the browser/context can't
  // support notifications — `role="alert"` lets assistive tech announce
  // them on first render.
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-md border border-input bg-muted/40 p-3 text-sm"
      data-testid={testid}
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <p>{message}</p>
    </div>
  );
}
