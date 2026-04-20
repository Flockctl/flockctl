import notifier from "node-notifier";

interface NotifyOptions {
  title: string;
  message: string;
  sound?: boolean;
}

class NotificationService {
  private enabled = true;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  notify(opts: NotifyOptions): void {
    if (!this.enabled) return;
    notifier.notify({
      title: `Flockctl: ${opts.title}`,
      message: opts.message,
      sound: opts.sound ?? false,
    });
  }

  taskCompleted(taskId: number, label?: string): void {
    this.notify({
      title: "Task Completed",
      message: label ?? `Task #${taskId} finished successfully`,
    });
  }

  taskFailed(taskId: number, error?: string): void {
    this.notify({
      title: "Task Failed",
      message: error ?? `Task #${taskId} failed`,
      sound: true,
    });
  }

  milestoneCompleted(title: string): void {
    this.notify({
      title: "Milestone Completed",
      message: title,
    });
  }
}

export const notificationService = new NotificationService();
