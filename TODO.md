- [x] Добавить вкладки skills/mcp где будет общий пул всех скилов/mcp

- [x] Добавить метрику времени типо сколько всего работали агенты за выбранный период

- [ ] Persist agent-side todo lists (Claude Code TodoWrite output) и показывать их в UI: прогресс-бар чата по активным todo, индикатор в списке чатов, возможность просматривать историю. Требует: новая таблица `chat_todos` (или extension к `chat_messages`), парсинг TodoWrite tool_use из SDK, WS-евент `todo_updated`.

[] добавить выбор директорий для добавления проектов или воркспейсов через выбор папки в UI (вместо ручного ввода пути)

- [ ] Adopt `.claude/commands/*` during existing-directory import — introduce a project-level commands concept (like skills/agents), detect in scan preview, register in DB, reconcile via symlinks. For now imports leave the folder untouched.

- добавить загрузку скриншотов в UI для чатов чтобы слать агенту
