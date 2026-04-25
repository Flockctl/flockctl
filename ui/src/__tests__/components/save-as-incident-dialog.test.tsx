import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  extractIncidentFromChat: vi.fn(),
  createIncident: vi.fn(),
  fetchIncidentTags: vi.fn(),
}));

import {
  extractIncidentFromChat,
  createIncident,
  fetchIncidentTags,
} from "@/lib/api";
import { SaveAsIncidentDialog } from "@/components/save-as-incident-dialog";

const mockExtract = extractIncidentFromChat as unknown as ReturnType<typeof vi.fn>;
const mockCreate = createIncident as unknown as ReturnType<typeof vi.fn>;
const mockFetchTags = fetchIncidentTags as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockExtract.mockReset();
  mockCreate.mockReset();
  mockFetchTags.mockReset();
  mockFetchTags.mockResolvedValue({ tags: [] });
});

function renderDialog(
  props: Partial<React.ComponentProps<typeof SaveAsIncidentDialog>> = {}
) {
  return render(
    <SaveAsIncidentDialog
      open={true}
      onOpenChange={() => {}}
      chatId="42"
      messageIds={[]}
      projectId={null}
      {...props}
    />
  );
}

describe("SaveAsIncidentDialog", () => {
  it("renders nothing when open=false", () => {
    mockExtract.mockResolvedValue({ draft: null });
    const { container } = render(
      <SaveAsIncidentDialog
        open={false}
        onOpenChange={() => {}}
        chatId="42"
        messageIds={[]}
        projectId={null}
      />
    );
    expect(container.querySelector("[data-testid='save-as-incident-dialog']"))
      .toBeNull();
  });

  it("pre-fills from extractor draft", async () => {
    mockExtract.mockResolvedValue({
      draft: {
        title: "Journal desync",
        symptom: "migrate broke",
        root_cause: "missing entry",
        resolution: "regenerate",
        tags: ["migration"],
      },
    });
    renderDialog();

    await waitFor(() => {
      expect(
        (screen.getByTestId("incident-title") as HTMLInputElement).value
      ).toBe("Journal desync");
    });
    expect(
      (screen.getByTestId("incident-symptom") as HTMLTextAreaElement).value
    ).toBe("migrate broke");
    expect(screen.getByText("migration")).toBeTruthy();
  });

  it("keeps the Save button disabled while title is empty", async () => {
    mockExtract.mockResolvedValue({ draft: null });
    renderDialog();
    await waitFor(() => {
      expect(mockExtract).toHaveBeenCalled();
    });
    const save = screen.getByTestId("incident-save-button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("does not clobber user-typed title with a late extractor draft", async () => {
    const user = userEvent.setup();
    // Delay extractor so user types first.
    let resolveExtract!: (v: any) => void;
    mockExtract.mockReturnValue(
      new Promise((r) => {
        resolveExtract = r;
      })
    );
    renderDialog();
    const titleInput = screen.getByTestId("incident-title") as HTMLInputElement;
    await user.type(titleInput, "My title");
    expect(titleInput.value).toBe("My title");

    resolveExtract({ draft: { title: "extractor title" } });
    await waitFor(() => {
      // touched.title=true, so draft must NOT overwrite.
      expect(titleInput.value).toBe("My title");
    });
  });

  it("saves a new incident with trimmed title and empty-to-null fields", async () => {
    const user = userEvent.setup();
    mockExtract.mockResolvedValue({ draft: null });
    mockCreate.mockResolvedValue({ id: 100 });
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    await waitFor(() => {
      expect(mockExtract).toHaveBeenCalled();
    });
    await user.type(screen.getByTestId("incident-title"), "  my title  ");
    await user.click(screen.getByTestId("incident-save-button"));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
    });
    const [arg] = mockCreate.mock.calls[0]!;
    expect(arg.title).toBe("my title");
    expect(arg.symptom).toBeNull();
    expect(arg.rootCause).toBeNull();
    expect(arg.resolution).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows save error when createIncident rejects", async () => {
    const user = userEvent.setup();
    mockExtract.mockResolvedValue({ draft: null });
    mockCreate.mockRejectedValue(new Error("500: down"));
    renderDialog();

    await waitFor(() => {
      expect(mockExtract).toHaveBeenCalled();
    });
    await user.type(screen.getByTestId("incident-title"), "t");
    await user.click(screen.getByTestId("incident-save-button"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("500: down");
    });
  });

  it("adds and removes tags via the tag input", async () => {
    const user = userEvent.setup();
    mockExtract.mockResolvedValue({ draft: null });
    renderDialog();

    await waitFor(() => {
      expect(mockExtract).toHaveBeenCalled();
    });
    const tagInput = screen.getByTestId("incident-tag-input");
    await user.type(tagInput, "sqlite{enter}");
    await user.type(tagInput, "journal,");
    expect(screen.getByText("sqlite")).toBeTruthy();
    expect(screen.getByText("journal")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove tag sqlite" }));
    expect(screen.queryByText("sqlite")).toBeNull();
  });

  it("offers typeahead tag suggestions when they match the draft", async () => {
    const user = userEvent.setup();
    mockExtract.mockResolvedValue({ draft: null });
    mockFetchTags.mockResolvedValue({ tags: ["migration", "ui", "journal"] });
    renderDialog();

    await waitFor(() => {
      expect(mockFetchTags).toHaveBeenCalled();
    });
    await user.type(screen.getByTestId("incident-tag-input"), "mig");
    const panel = await screen.findByTestId("incident-tag-suggestions");
    expect(panel.textContent).toContain("migration");
  });
});
