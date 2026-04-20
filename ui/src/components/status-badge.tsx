import { Badge } from "@/components/ui/badge";

export function statusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary">pending</Badge>;
    case "planning":
      return <Badge variant="secondary">planning</Badge>;
    case "active":
    case "in_progress":
      return <Badge>active</Badge>;
    case "running":
      return <Badge>running</Badge>;
    case "pending_approval":
      return (
        <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
          pending approval
        </Badge>
      );
    case "verifying":
    case "merging":
      return (
        <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
          {status}
        </Badge>
      );
    case "completed":
    case "done":
    case "merged":
      return (
        <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400">
          {status}
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    case "skipped":
    case "cancelled":
      return <Badge variant="outline">{status}</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}
