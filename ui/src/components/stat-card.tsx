import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function StatCard({
  icon: Icon,
  label,
  value,
  subtitle,
  isLoading,
  testId,
}: {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  value: number | string;
  subtitle?: string;
  isLoading: boolean;
  /** Forwarded as `data-testid` on the rendered <Card>. Lets callers drop
   *  the wrapper `<div data-testid="…">` they previously needed — the wrapper
   *  was preventing the inner Card from stretching to the grid-cell height,
   *  so the wrapped slots rendered visibly shorter than the un-wrapped ones. */
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          <Icon className="mr-2 inline h-4 w-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">
          {isLoading ? <Skeleton className="h-8 w-16" /> : value}
        </div>
        {subtitle && !isLoading && (
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}
