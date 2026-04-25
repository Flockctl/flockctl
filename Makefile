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
# `flockctl stop` now blocks until the child process actually exits (up to
# 15 s, matches the shutdown budget). If it times out we bail loudly instead
# of papering over it — that should prompt the operator to investigate, not
# auto-force-kill.
reinstall:
	@flockctl stop 2>/dev/null || true
	@if lsof -ti :52077 >/dev/null 2>&1; then \
		echo "❌ port 52077 still busy after flockctl stop — refusing to reinstall."; \
		echo "   Investigate the stuck process manually before retrying."; \
		exit 1; \
	fi
	npm run build
	npm install -g .
	flockctl start
	@echo "\n✅ flockctl reinstalled and started successfully."
