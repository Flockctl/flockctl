# CLAUDE.md identical to AGENTS.md

AGENTS.md carries the flockctl-managed header so the scanner treats it as
already-adopted (no `--adopt-agents-md` needed). CLAUDE.md is an exact
byte-for-byte copy, so the scanner reports `sameAsAgents=true` and skips
the merge branch automatically — exit 0 without any flags.
