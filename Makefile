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
reinstall:
	-flockctl stop 2>/dev/null || true
	npm run build
	npm install -g .
	flockctl start
	@echo "\n✅ flockctl reinstalled and started successfully."
