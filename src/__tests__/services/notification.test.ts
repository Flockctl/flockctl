import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node-notifier
vi.mock("node-notifier", () => ({
  default: {
    notify: vi.fn(),
  },
}));

import notifier from "node-notifier";
import { notificationService } from "../../services/notification.js";

const mockNotify = notifier.notify as any;

describe("NotificationService", () => {
  beforeEach(() => {
    mockNotify.mockClear();
    notificationService.setEnabled(true);
  });

  it("notify sends desktop notification", () => {
    notificationService.notify({ title: "Test", message: "Hello" });
    expect(mockNotify).toHaveBeenCalledWith({
      title: "Flockctl: Test",
      message: "Hello",
      sound: false,
    });
  });

  it("notify with sound=true", () => {
    notificationService.notify({ title: "Alert", message: "Error", sound: true });
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ sound: true }),
    );
  });

  it("notify is suppressed when disabled", () => {
    notificationService.setEnabled(false);
    notificationService.notify({ title: "Test", message: "Should not send" });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("setEnabled(true) re-enables notifications", () => {
    notificationService.setEnabled(false);
    notificationService.setEnabled(true);
    notificationService.notify({ title: "Re-enabled", message: "Works" });
    expect(mockNotify).toHaveBeenCalledOnce();
  });

  it("taskCompleted sends notification with label", () => {
    notificationService.taskCompleted(42, "Build passed");
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Flockctl: Task Completed",
        message: "Build passed",
      }),
    );
  });

  it("taskCompleted sends notification with default message", () => {
    notificationService.taskCompleted(42);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Task #42 finished successfully",
      }),
    );
  });

  it("taskFailed sends notification with sound", () => {
    notificationService.taskFailed(7, "OOM");
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Flockctl: Task Failed",
        message: "OOM",
        sound: true,
      }),
    );
  });

  it("taskFailed sends default message when no error", () => {
    notificationService.taskFailed(7);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Task #7 failed",
      }),
    );
  });

  it("milestoneCompleted sends notification", () => {
    notificationService.milestoneCompleted("Deploy v2");
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Flockctl: Milestone Completed",
        message: "Deploy v2",
      }),
    );
  });
});
