import { Plus, Pencil, Minus, FileText } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";

/**
 * FilesTouchedPanel — right-rail list of files modified by the task
 * (M19/03). Source of truth is the diff endpoint the caller
 * already invokes via `fetchTaskDiff(taskId)`; the panel takes the
 * derived list as a prop.
 *
 * `M`/`A`/`D` codes are mapped to icons + tones consistent with the
 * SCM panel's status badges so the operator sees the same visual
 * language across surfaces.
 */

export type FileChange = {
  path: string;
  /** M (modified), A (added), D (deleted), R (renamed), C (copied), T (type-change). */
  status: "M" | "A" | "D" | "R" | "C" | "T";
  /** Optional pre-rename path on R/C — surfaced in the title attr. */
  oldPath?: string;
};

export interface FilesTouchedPanelProps {
  files: ReadonlyArray<FileChange>;
  loading?: boolean;
  /** Click handler — typically opens the diff for that path. */
  onSelectFile?: (file: FileChange) => void;
}

function StatusBadge({ status }: { status: FileChange["status"] }) {
  const cfg: Record<FileChange["status"], { icon: typeof Plus; tone: string; label: string }> = {
    M: { icon: Pencil, tone: "text-amber-600", label: "Modified" },
    A: { icon: Plus, tone: "text-emerald-600", label: "Added" },
    D: { icon: Minus, tone: "text-red-600", label: "Deleted" },
    R: { icon: Pencil, tone: "text-blue-600", label: "Renamed" },
    C: { icon: Pencil, tone: "text-blue-500", label: "Copied" },
    T: { icon: Pencil, tone: "text-purple-600", label: "Type-change" },
  };
  const { icon: Icon, tone, label } = cfg[status];
  return (
    <span aria-label={label} className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export function FilesTouchedPanel({ files, loading, onSelectFile }: FilesTouchedPanelProps) {
  return (
    <div data-testid="task-detail-files-panel" className="rounded-lg border bg-card p-3">
      <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        Files touched ({files.length})
      </h3>
      {loading ? (
        <div className="space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-4 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : files.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No file changes"
          description="The task hasn't written any tracked files yet."
          className="bg-transparent"
        />
      ) : (
        <ul className="space-y-0.5">
          {files.map((f) => {
            const RowTag: "button" | "div" = onSelectFile ? "button" : "div";
            return (
              <li key={`${f.status}:${f.path}`}>
                <RowTag
                  type={onSelectFile ? "button" : undefined}
                  onClick={onSelectFile ? () => onSelectFile(f) : undefined}
                  title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                  className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] ${
                    onSelectFile ? "hover:bg-accent/40" : ""
                  }`}
                  data-testid="task-detail-file-row"
                >
                  <StatusBadge status={f.status} />
                  <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                </RowTag>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default FilesTouchedPanel;
