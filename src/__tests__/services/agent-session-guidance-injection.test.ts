import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentSession } from "../../services/agent-session/index.js";
import type {
  AgentProvider,
  ChatOptions,
  ChatResult,
} from "../../services/agents/types.js";

/**
 * Capturing mock provider. Records every `chat(opts)` call so tests can
 * assert on the `system` field — which is what we need to prove
 * `injectAgentGuidance` actually reached the SDK call.
 */
function makeCapturingProvider(): {
  provider: AgentProvider;
  calls: ChatOptions[];
} {
  const calls: ChatOptions[] = [];
  const provider: AgentProvider = {
    id: "test-capture",
    displayName: "Test Capture",
    listModels: () => [],
    checkReadiness: () => ({ ready: true }) as never,
    chat: async (opts): Promise<ChatResult> => {
      calls.push(opts);
      return {
        text: "",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 } as never,
      };
    },
    streamChat: async function* () {
      /* v8 ignore next — unused in these tests */
      yield* [];
    },
    estimateCost: () => 0,
  };
  return { provider, calls };
}

let tmpBase: string;
let savedFlockctlHome: string | undefined;

beforeEach(() => {
  tmpBase = join(
    tmpdir(),
    `flockctl-guidance-inject-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpBase, { recursive: true });
  savedFlockctlHome = process.env.FLOCKCTL_HOME;
  // Point FLOCKCTL_HOME at a clean tmp dir so the loader's `user` layer
  // doesn't leak the developer's real ~/flockctl/AGENTS.md into the test.
  process.env.FLOCKCTL_HOME = join(tmpBase, "flockctl-home");
  mkdirSync(process.env.FLOCKCTL_HOME, { recursive: true });
});

afterEach(() => {
  if (savedFlockctlHome === undefined) delete process.env.FLOCKCTL_HOME;
  else process.env.FLOCKCTL_HOME = savedFlockctlHome;
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // intentionally swallow
  }
});

function makeSession(opts: {
  provider: AgentProvider;
  workingDir?: string;
  workspaceContext?: {
    name: string;
    path: string;
    projects: Array<{
      name: string;
      path: string | null;
      description?: string | null;
    }>;
  };
}) {
  return new AgentSession({
    taskId: 42,
    prompt: "noop",
    model: "test-model",
    codebaseContext: "",
    provider: opts.provider,
    workingDir: opts.workingDir,
    workspaceContext: opts.workspaceContext,
  });
}

describe("AgentSession.injectAgentGuidance", () => {
  it("injects_three_layers_between_workspace_projects_and_end", async () => {
    // Seed the three public layers with distinct markers. All three must
    // surface in `opts.system` when run() hands the prompt to the provider.
    const flockctlHome = process.env.FLOCKCTL_HOME!;
    const workspacePath = join(tmpBase, "ws");
    const projectPath = join(workspacePath, "proj");
    mkdirSync(projectPath, { recursive: true });

    writeFileSync(join(flockctlHome, "AGENTS.md"), "MARK_USER\n");
    writeFileSync(join(workspacePath, "AGENTS.md"), "MARK_WS_PUBLIC\n");
    writeFileSync(join(projectPath, "AGENTS.md"), "MARK_PROJ_PUBLIC\n");

    const { provider, calls } = makeCapturingProvider();
    const session = makeSession({
      provider,
      workingDir: projectPath,
      workspaceContext: {
        name: "ws",
        path: workspacePath,
        projects: [{ name: "proj", path: projectPath }],
      },
    });
    await session.run();

    expect(calls).toHaveLength(1);
    const { system } = calls[0]!;
    // All three content markers appear, in the documented layer order:
    //   user → workspace-public → project-public
    const orderedMarkers = ["MARK_USER", "MARK_WS_PUBLIC", "MARK_PROJ_PUBLIC"];
    const markerOffsets = orderedMarkers.map((m) => system.indexOf(m));
    for (let i = 0; i < orderedMarkers.length; i++) {
      expect(markerOffsets[i], `missing ${orderedMarkers[i]}`).toBeGreaterThan(0);
    }
    for (let i = 1; i < markerOffsets.length; i++) {
      expect(
        markerOffsets[i],
        `${orderedMarkers[i]} should come after ${orderedMarkers[i - 1]}`,
      ).toBeGreaterThan(markerOffsets[i - 1]!);
    }

    // Each content marker is preceded by its own layer-header banner, and the
    // banners themselves appear in the documented layer order.
    const orderedLayers = ["user", "workspace-public", "project-public"];
    const bannerOffsets = orderedLayers.map((layer) => {
      const re = new RegExp(`flockctl:agent-guidance layer=${layer}\\b`);
      const m = re.exec(system);
      return m ? m.index : -1;
    });
    for (let i = 0; i < orderedLayers.length; i++) {
      expect(bannerOffsets[i], `missing banner for ${orderedLayers[i]}`).toBeGreaterThan(0);
      // Banner comes immediately before its content marker.
      expect(bannerOffsets[i]).toBeLessThan(markerOffsets[i]!);
    }
    for (let i = 1; i < bannerOffsets.length; i++) {
      expect(bannerOffsets[i]).toBeGreaterThan(bannerOffsets[i - 1]!);
    }

    // Guidance section comes AFTER the existing <workspace_projects> block
    // — guidance is last in the chain, most recent context for the model.
    const wpIdx = system.indexOf("<workspace_projects");
    expect(wpIdx).toBeGreaterThan(0);
    expect(markerOffsets[0]).toBeGreaterThan(wpIdx);

    // End banner present.
    expect(system).toMatch(/flockctl:agent-guidance end total_bytes=\d+/);
  });

  it("session_without_guidance_files_produces_prompt_without_injection_section", async () => {
    const workspacePath = join(tmpBase, "ws-empty");
    const projectPath = join(workspacePath, "proj-empty");
    mkdirSync(projectPath, { recursive: true });

    const { provider, calls } = makeCapturingProvider();
    const session = makeSession({
      provider,
      workingDir: projectPath,
      workspaceContext: {
        name: "ws-empty",
        path: workspacePath,
        projects: [{ name: "proj-empty", path: projectPath }],
      },
    });
    await session.run();

    expect(calls).toHaveLength(1);
    const { system } = calls[0]!;
    expect(system).not.toContain("flockctl:agent-guidance");
  });

  it("session_with_only_user_global_layer_injects_that_layer_alone", async () => {
    const flockctlHome = process.env.FLOCKCTL_HOME!;
    writeFileSync(join(flockctlHome, "AGENTS.md"), "ONLY_USER\n");

    const projectPath = join(tmpBase, "proj-standalone");
    mkdirSync(projectPath, { recursive: true });

    const { provider, calls } = makeCapturingProvider();
    const session = makeSession({
      provider,
      workingDir: projectPath,
      // no workspaceContext
    });
    await session.run();

    const { system } = calls[0]!;
    expect(system).toContain("ONLY_USER");
    expect(system).toMatch(
      /flockctl:agent-guidance layer=user path=.+AGENTS\.md/,
    );
    // No workspace-public / project-public banners.
    expect(system).not.toMatch(/layer=workspace-public/);
    expect(system).not.toMatch(/layer=project-public/);
  });

  it("session_with_empty_files_skips_empty_layers", async () => {
    const flockctlHome = process.env.FLOCKCTL_HOME!;
    const workspacePath = join(tmpBase, "ws-mix");
    const projectPath = join(workspacePath, "proj-mix");
    mkdirSync(projectPath, { recursive: true });

    // user non-empty, ws-public empty, proj-public non-empty.
    writeFileSync(join(flockctlHome, "AGENTS.md"), "ACTIVE_USER\n");
    writeFileSync(join(workspacePath, "AGENTS.md"), "");
    writeFileSync(join(projectPath, "AGENTS.md"), "ACTIVE_PROJ_PUBLIC\n");

    const { provider, calls } = makeCapturingProvider();
    const session = makeSession({
      provider,
      workingDir: projectPath,
      workspaceContext: {
        name: "ws-mix",
        path: workspacePath,
        projects: [{ name: "proj-mix", path: projectPath }],
      },
    });
    await session.run();

    const { system } = calls[0]!;
    expect(system).toContain("ACTIVE_USER");
    expect(system).toContain("ACTIVE_PROJ_PUBLIC");
    expect(system).toMatch(/layer=user/);
    expect(system).toMatch(/layer=project-public/);
    expect(system).not.toMatch(/layer=workspace-public/);
  });

  it("does_not_read_flockctl_home_layer_twice_when_workingDir_equals_home", async () => {
    // Guard against the double-read the explicit equality check in
    // injectAgentGuidance is designed to prevent. Without it, the loader
    // would pick up <flockctlHome>/AGENTS.md as both `user` and
    // `project-public`.
    const flockctlHome = process.env.FLOCKCTL_HOME!;
    writeFileSync(join(flockctlHome, "AGENTS.md"), "HOME_ONLY\n");

    const { provider, calls } = makeCapturingProvider();
    const session = makeSession({
      provider,
      workingDir: flockctlHome, // task session without project scope
    });
    await session.run();

    const { system } = calls[0]!;
    expect(system).toContain("HOME_ONLY");
    // The string should appear exactly once in the merged section.
    const banners = system.match(/flockctl:agent-guidance layer=\S+/g) ?? [];
    expect(banners).toHaveLength(1);
    expect(banners[0]).toContain("layer=user");
  });
});
