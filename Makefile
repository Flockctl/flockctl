.PHONY: dev dev-back dev-front build test start stop status clean reinstall

# Start both backend and frontend
dev:
	@lsof -ti :52077 | xargs kill -9 2>/dev/null || true
	@echo "→ backend:  http://localhost:52077"
	@echo "→ frontend: http://localhost:5173"
	@trap 'kill 0' EXIT INT TERM; \
		npx tsx watch src/server-entry.ts & \
		cd ui && npm run dev & \
		wait

dev-back:
	npx tsx watch src/server-entry.ts

dev-front:
	cd ui && npm run dev

build:
	npx tsc

check:
	cd ui && npx vite build --mode production > /dev/null
	npx vitest run
	@echo "\n✅ All checks passed (UI build + tests)"

test:
	npx vitest run

start:
	npm start

stop:
	npm stop

status:
	npm run status

clean:
	rm -rf dist

# Rebuild (TS + UI) and reinstall globally. Stops a running flockctl first.
#
# IMPORTANT: never SIGKILL (`kill -9`) the daemon here. The graceful-shutdown
# path in server-entry.ts drains in-flight chat streams and flushes each
# chat's `claudeSessionId`; forcing the process to die mid-drain leaves a
# stale session id in SQLite, so the next user message tries to
# `claude --resume <dead-id>` and starts from scratch — which is exactly the
# "context lost on make reinstall" bug.
#
# Step-by-step:
#   1. Stop the daemon if `flockctl` exists in PATH; tolerate first-install
#      where the binary isn't there yet.
#   2. Poll `lsof :52077` for up to 15 s for the port to be released —
#      `flockctl stop` returns when the child exits, but the kernel may
#      hold the listening socket in TIME_WAIT for a tick.
#   3. `npm run build` (TS + UI bundle copied into dist/ui).
#   4. `npm install -g .` — if this fails (EACCES, nvm prefix, etc.)
#      the whole target aborts; we never try to start a half-installed
#      daemon.
#   5. `flockctl start` and poll `/health` for up to 10 s before
#      reporting success. A green ✅ means the daemon actually answers
#      HTTP, not just that the launcher returned.
reinstall:
	@if command -v flockctl >/dev/null 2>&1; then \
		echo "→ Stopping running daemon (graceful, no SIGKILL)…"; \
		flockctl stop 2>/dev/null || true; \
	else \
		echo "→ flockctl not in PATH yet — skipping stop (first install)."; \
	fi
	@printf "→ Waiting for port 52077 to be released"
	@released=0; for i in $$(seq 1 30); do \
		if ! lsof -ti :52077 >/dev/null 2>&1; then released=1; break; fi; \
		printf "."; sleep 0.5; \
	done; \
	echo ""; \
	if [ $$released -ne 1 ]; then \
		echo "❌ port 52077 still busy after 15 s — refusing to reinstall."; \
		echo "   Stuck PID(s): $$(lsof -ti :52077 | tr '\n' ' ')"; \
		echo "   Investigate manually (e.g. \`kill <pid>\`) before retrying."; \
		exit 1; \
	fi
	@echo "→ Building (tsc + ui bundle)…"
	npm run build
	@echo "→ Installing globally (npm install -g .)…"
	npm install -g .
	@echo "→ Starting daemon…"
	flockctl start
	@printf "→ Waiting for /health to respond"
	@healthy=0; for i in $$(seq 1 20); do \
		if curl -sf http://localhost:52077/health >/dev/null 2>&1; then healthy=1; break; fi; \
		printf "."; sleep 0.5; \
	done; \
	echo ""; \
	if [ $$healthy -ne 1 ]; then \
		echo "⚠️  daemon started but /health did not answer within 10 s."; \
		echo "   Check logs: \`flockctl status\` and ~/.flockctl/daemon.log"; \
		exit 1; \
	fi
	@echo ""
	@echo "✅ flockctl reinstalled and healthy on http://localhost:52077"
