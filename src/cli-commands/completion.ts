/**
 * `flockctl completion <bash|zsh|fish>` — print a shell-completion script.
 *
 * Commander.js does not ship completion scripts of its own, so we emit a
 * deliberately minimal one: tab-complete the top-level subcommand name and
 * stop there. That covers the 95% case (the user remembers there's a
 * `tasks` group but forgets the exact name) without trying to mirror every
 * flag — flag completion would couple the script to internal command shape
 * and rot the moment we add a new option.
 *
 * Output contract:
 *   - stdout receives exactly the script. Nothing else.
 *   - the script is meant to be sourced verbatim:
 *       eval "$(flockctl completion bash)"     # bash / zsh
 *       flockctl completion fish | source      # fish
 *
 * The list of subcommands is built from the registered commander tree at
 * the moment this command is invoked — so adding a new top-level command
 * automatically extends completion without touching this file.
 */
import type { Command } from "commander";

type Shell = "bash" | "zsh" | "fish";

function topLevelSubcommands(program: Command): string[] {
  return program.commands
    .map((c) => c.name())
    .filter((n) => n && n !== "completion")
    .sort();
}

function bashScript(subcommands: string[]): string {
  const list = subcommands.join(" ");
  return `# flockctl bash completion
_flockctl_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${list}" -- "\${cur}") )
    return 0
  fi
  return 0
}
complete -F _flockctl_completion flockctl
`;
}

function zshScript(subcommands: string[]): string {
  const list = subcommands.join(" ");
  return `# flockctl zsh completion
_flockctl() {
  local -a subcommands
  subcommands=(${list.split(" ").map((s) => `'${s}'`).join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'flockctl subcommand' subcommands
  fi
}
compdef _flockctl flockctl
`;
}

function fishScript(subcommands: string[]): string {
  // Fish gets one `complete -c flockctl -f -n "__fish_use_subcommand" -a NAME` per subcommand.
  const lines = subcommands.map(
    (s) => `complete -c flockctl -f -n "__fish_use_subcommand" -a "${s}"`,
  );
  return `# flockctl fish completion\n${lines.join("\n")}\n`;
}

function emit(shell: Shell, subcommands: string[]): string {
  switch (shell) {
    case "bash":
      return bashScript(subcommands);
    case "zsh":
      return zshScript(subcommands);
    case "fish":
      return fishScript(subcommands);
  }
}

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion <shell>")
    .description(
      "Print a shell-completion script for bash, zsh, or fish. " +
        "Source the output to enable tab-completion of the top-level subcommand name. " +
        "Examples:\n" +
        "  bash/zsh: eval \"$(flockctl completion bash)\"\n" +
        "  fish:     flockctl completion fish | source",
    )
    .action((shell: string) => {
      if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
        process.stderr.write(
          `Error: unsupported shell '${shell}'. Supported: bash, zsh, fish.\n`,
        );
        process.exit(1);
      }
      const subs = topLevelSubcommands(program);
      process.stdout.write(emit(shell, subs));
    });
}
