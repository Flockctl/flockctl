import { describe, it, expect } from "vitest";
import { Command } from "commander";

describe("CLI", () => {
  function createTestProgram() {
    const program = new Command();
    program.exitOverride(); // Don't call process.exit
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });

    program
      .name("flockctl")
      .description("Local AI task orchestration tool")
      .version("1.0.0");

    const actions: Record<string, any> = {};

    program
      .command("start")
      .description("Start Flockctl web server in background")
      .option("-p, --port <number>", "Port to listen on", "52077")
      .action((opts) => {
        actions.start = { port: parseInt(opts.port, 10) };
      });

    program
      .command("stop")
      .description("Stop Flockctl web server")
      .action(() => {
        actions.stop = true;
      });

    program
      .command("status")
      .description("Check if Flockctl is running")
      .action(() => {
        actions.status = true;
      });

    return { program, actions };
  }

  it("parses start command with default port", () => {
    const { program, actions } = createTestProgram();
    program.parse(["node", "flockctl", "start"]);
    expect(actions.start).toEqual({ port: 52077 });
  });

  it("parses start command with custom port", () => {
    const { program, actions } = createTestProgram();
    program.parse(["node", "flockctl", "start", "-p", "8080"]);
    expect(actions.start).toEqual({ port: 8080 });
  });

  it("parses start command with --port", () => {
    const { program, actions } = createTestProgram();
    program.parse(["node", "flockctl", "start", "--port", "3000"]);
    expect(actions.start).toEqual({ port: 3000 });
  });

  it("parses stop command", () => {
    const { program, actions } = createTestProgram();
    program.parse(["node", "flockctl", "stop"]);
    expect(actions.stop).toBe(true);
  });

  it("parses status command", () => {
    const { program, actions } = createTestProgram();
    program.parse(["node", "flockctl", "status"]);
    expect(actions.status).toBe(true);
  });

  it("throws on unknown command", () => {
    const { program } = createTestProgram();
    expect(() => program.parse(["node", "flockctl", "unknown"])).toThrow();
  });
});
