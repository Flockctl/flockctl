import { useBudgets, useDeleteBudget } from "@/lib/hooks";
import type { BudgetSummaryItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Trash2 } from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

// --- Budget Table ---

export function BudgetTable() {
  const { data: budgets, isLoading, error } = useBudgets();
  const deleteBudget = useDeleteBudget();
  const deleteConfirm = useConfirmDialog();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-destructive">Failed to load budgets: {error.message}</p>;
  }

  if (!budgets || budgets.length === 0) {
    return <p className="text-sm text-muted-foreground">No budget limits configured.</p>;
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scope</TableHead>
            <TableHead className="hidden sm:table-cell">Period</TableHead>
            <TableHead>Limit</TableHead>
            <TableHead className="hidden md:table-cell">Spent</TableHead>
            <TableHead className="hidden md:table-cell">Usage</TableHead>
            <TableHead className="hidden lg:table-cell">Action</TableHead>
            <TableHead className="w-[100px]">Controls</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {budgets.map((b: BudgetSummaryItem) => (
            <TableRow key={b.id}>
              <TableCell className="text-sm">
                <Badge variant="outline">{b.scope}</Badge>
                {b.scope_id && <span className="ml-1 text-xs text-muted-foreground">#{b.scope_id}</span>}
              </TableCell>
              <TableCell className="hidden text-sm sm:table-cell">{b.period}</TableCell>
              <TableCell className="text-sm font-mono">${b.limit_usd.toFixed(2)}</TableCell>
              <TableCell className="hidden text-sm font-mono md:table-cell">${b.spent_usd.toFixed(2)}</TableCell>
              <TableCell className="hidden md:table-cell">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-20 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        b.percent_used >= 100
                          ? "bg-red-500"
                          : b.percent_used >= 80
                            ? "bg-amber-500"
                            : "bg-green-500"
                      }`}
                      style={{ width: `${Math.min(b.percent_used, 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground">{b.percent_used.toFixed(0)}%</span>
                </div>
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <Badge variant={b.action === "pause" ? "destructive" : "secondary"}>
                  {b.action}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                    disabled={deleteBudget.isPending}
                    onClick={() => deleteConfirm.requestConfirm(String(b.id))}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Budget Limit"
        description="This will permanently remove this budget limit. This action cannot be undone."
        isPending={deleteBudget.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteBudget.mutate(Number(deleteConfirm.targetId), {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </>
  );
}
