
- [ ] Interactive agent questions (AskUserQuestion-style): let the AI pause mid-execution and ask the user a free-form clarifying question, not only tool-permission prompts. Scope: new `askUser` tool in `agent-tools.ts`, WS event `agent_question` + REST resume endpoint `POST /tasks|chats/:id/question/:requestId`, task status `waiting_for_input`, UI prompt in task/chat view. Today only permission requests are handled via `POST /{tasks,chats}/:id/permission/:requestId`.

- [ ] Adopt `.claude/commands/*` during existing-directory import — introduce a project-level commands concept (like skills/agents), detect in scan preview, register in DB, reconcile via symlinks. For now imports leave the folder untouched.

- [ ] Нужен какой-то механизм для того чтобы хранить secrets так чтобы у агента к ним не было доступа. МБ через вебхук ограничивать доспут агента к базе? И то же самое надо делать с mcp 