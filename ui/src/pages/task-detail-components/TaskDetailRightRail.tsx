import type { Task } from "@/lib/types/task";
import { StatusPanel } from "./StatusPanel";
import { CostPanel, type CostPanelProps } from "./CostPanel";
import { FilesTouchedPanel, type FileChange } from "./FilesTouchedPanel";

/**
 * TaskDetailRightRail — composes the three M19/03 panels into a
 * single 280-px column. The page wires the data; this component is
 * pure layout.
 */

export interface TaskDetailRightRailProps {
  task: Task;
  projectName?: string | null;
  cost: CostPanelProps;
  files: ReadonlyArray<FileChange>;
  filesLoading?: boolean;
  onSelectFile?: (file: FileChange) => void;
}

export function TaskDetailRightRail({
  task,
  projectName,
  cost,
  files,
  filesLoading,
  onSelectFile,
}: TaskDetailRightRailProps) {
  return (
    <aside
      data-testid="task-detail-right-rail"
      aria-label="Task summary"
      className="flex w-[280px] shrink-0 flex-col gap-3"
    >
      <StatusPanel task={task} projectName={projectName} />
      <CostPanel {...cost} />
      <FilesTouchedPanel files={files} loading={filesLoading} onSelectFile={onSelectFile} />
    </aside>
  );
}

export default TaskDetailRightRail;
