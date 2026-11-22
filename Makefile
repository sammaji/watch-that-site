# Makefile for WatchThatSite
# Run 'make help' to see available commands

ECHO := printf '%b\n'
YELLOW := \033[33m
GREEN := \033[32m
CYAN := \033[36m
NC := \033[0m

# Postgres, PostgREST, RabbitMQ and the Bifrost model gateway (with its own
# Postgres): everything the stack needs from Docker.
# MinIO (profile "storage") and the proxy image (profile "services") are
# optional and started by name.
PROFILES := --profile core

.PHONY: help install setup setup-env dev build docker-up docker-down \
	docker-reset docker-logs docker-ps db-up wait-db db-setup db-down psql \
	create-roles migrate backfill-jwks run-notification-service \
	run-seeder-scripts run-browser-worker setup-workspace init clean

help:
	@echo "WatchThatSite development commands"
	@echo "=================================="
	@echo ""
	@echo "Setup:"
	@echo "  make init          - First-time setup: env, Go workspace, dependencies,"
	@echo "                       infra, migrations and PostgREST keys. Leaves infra running"
	@echo "  make install       - Install JS dependencies with pnpm"
	@echo "  make setup-env     - Create .env from .env.example, fill local secrets,"
	@echo "                       and symlink it into apps, packages and services"
	@echo "  make setup         - install + setup-env"
	@echo "  make setup-workspace - Recreate the Go workspace (services/go.work)"
	@echo ""
	@echo "Development:"
	@echo "  make dev           - Start the JS apps with Turbo (web :3000, site :3001,"
	@echo "                       docs :3002, sample pages :3003)"
	@echo "  make build         - Build the JS apps"
	@echo "  make run-scheduler-service    - Run the scheduler (admin API :5210)"
	@echo "  make run-notification-service - Run the notification worker"
	@echo "  make run-browser-worker       - Run the browser worker (agent API :5220)"
	@echo "  make run-seeder-scripts       - Seed Monitors (COUNT=20)"
	@echo ""
	@echo "Infrastructure:"
	@echo "  make docker-up     - Start Postgres (:5200), PostgREST (:5201), RabbitMQ (:5672)"
	@echo "                       and the Bifrost model gateway (:5203)"
	@echo "  make docker-down   - Stop them, keeping data"
	@echo "  make docker-reset  - Stop them and delete their data"
	@echo "  make docker-logs   - Follow their logs"
	@echo "  make docker-ps     - Show their status"
	@echo "  make db-up         - Start only Postgres and PostgREST"
	@echo "  make db-down       - Stop Postgres and PostgREST"
	@echo ""
	@echo "Database:"
	@echo "  make migrate       - Apply packages/db/migrations (schema, functions, policies)"
	@echo "  make db-setup      - db-up, wait for Postgres, migrate"
	@echo "  make create-roles  - Create the PostgREST roles (migrate does this too)"
	@echo "  make psql          - Open psql inside the Postgres container"
	@echo "  make backfill-jwks - Copy Better Auth's JWKS into PGRST_JWT_SECRET and"
	@echo "                       restart PostgREST (OVERWRITE=true after wiping the database)"
	@echo ""
	@echo "Utility:"
	@echo "  make clean         - Remove docker volumes, node_modules and build caches"

install:
	pnpm install

setup-env:
	@chmod +x scripts/**/*.sh
	@./scripts/post_install.sh

setup: install setup-env
	@echo "Setup complete."

dev:
	pnpm turbo dev

build:
	pnpm turbo build

docker-up:
	@cd infra && docker compose $(PROFILES) up -d
	@echo "Started WatchThatSite infra."

docker-down:
	cd infra && docker compose $(PROFILES) down
	@echo "Stopped WatchThatSite infra."

docker-reset:
	cd infra && docker compose $(PROFILES) down -v
	@echo "Stopped WatchThatSite infra and deleted its data."

docker-logs:
	cd infra && docker compose $(PROFILES) logs -f

docker-ps:
	cd infra && docker compose ps

db-up:
	cd infra && docker compose $(PROFILES) up -d watchthatsite-postgres watchthatsite-postgrest
	@echo "Started database infra."

# Waits until Postgres accepts connections (it takes a few seconds after "up").
wait-db:
	@echo "Waiting for PostgreSQL to be ready..."
	@timeout=120; \
	while ! docker exec watchthatsite-postgres pg_isready >/dev/null 2>&1; do \
		timeout=$$((timeout - 1)); \
		if [ $$timeout -le 0 ]; then \
			echo "ERROR: Timed out waiting for PostgreSQL"; \
			exit 1; \
		fi; \
		sleep 1; \
	done

db-setup: db-up wait-db
	$(MAKE) migrate
	@echo "Database setup complete."

db-down:
	cd infra && docker compose $(PROFILES) down watchthatsite-postgres watchthatsite-postgrest

psql:
	docker exec -it watchthatsite-postgres psql -U $$POSTGRES_USER -d $$POSTGRES_DATABASE

create-roles:
	./scripts/create_roles.sh

migrate:
	cd ./scripts/migrator && export $$(grep -v '^\#' ../../.env | xargs) && go run main.go

# PostgREST verifies the web app's JWTs with Better Auth's public keys. They
# are created in the database the first time the web app runs, so the web app
# is started for a moment to fetch them. PostgREST reads PGRST_JWT_SECRET only
# at start, hence the recreate. Pass OVERWRITE=true after wiping the database.
backfill-jwks:
	@echo "Starting web app to fetch JWKS..."
	@pnpm dev --filter @watchthatsite/web & \
	WEB_PID=$$!; \
	trap "kill $$WEB_PID 2>/dev/null; pkill -P $$WEB_PID 2>/dev/null" EXIT; \
	./scripts/backfill_jwks.sh; \
	kill $$WEB_PID 2>/dev/null || true; \
	pkill -P $$WEB_PID 2>/dev/null || true
	@cd infra && docker compose $(PROFILES) up -d --force-recreate watchthatsite-postgrest
	@echo "JWKS backfill complete."

run-%-service:
	@cd services/$* && export $$(grep -v '^\#' ../../.env | xargs) && go run .

run-notification-service:
	@cd services/notifications && export $$(grep -v '^\#' .env | xargs) && go run ./cmd/main.go

COUNT ?= 20
run-seeder-scripts:
	cd scripts/seeder && export $$(grep -v '^\#' ../../.env | xargs) && go run . -count_monitors $(COUNT)

run-browser-worker:
	cd services/browser-worker && npm run start

setup-workspace:
	@$(ECHO) "$(YELLOW)Cleaning existing workspace...$(NC)"
	@cd ./services && rm -f go.work go.work.sum || true
	@$(ECHO) "$(YELLOW)Initializing new workspace...$(NC)"
	@cd ./services && go work init $$(find . ../packages -maxdepth 2 -name go.mod -exec dirname {} \;)
	@$(ECHO) "$(YELLOW)Syncing workspace...$(NC)"
	@cd ./services && go work sync
	@$(ECHO) "$(GREEN)✓ Go workspace ready with all local modules$(NC)"
	@$(ECHO) ""
	@$(ECHO) "$(CYAN)Local modules in workspace:$(NC)"
	@cd ./services && go list -m all | grep "github.com/sammaji/watchthatsite" | grep -v " v" | sed 's/^/  ✓ /' || true
	@$(ECHO) ""
	@$(ECHO) "$(CYAN)Remote modules (no local version):$(NC)"
	@cd ./services && go list -m all | grep "github.com/sammaji/watchthatsite" | grep " v" | sed 's/^/  → /' || true
	@$(ECHO) ""
	@$(ECHO) "$(YELLOW)Note: go.work files are not committed to version control$(NC)"


init:
	@$(ECHO) "$(YELLOW)Creating .env and symlinks...$(NC)"
	$(MAKE) setup-env
	$(MAKE) setup-workspace
	@$(ECHO) "$(YELLOW)Installing dependencies...$(NC)"
	$(MAKE) install
	@$(ECHO) "$(GREEN) ✓ Installed dependencies.$(NC)"
	@$(ECHO) "$(YELLOW)Starting infra...$(NC)"
	$(MAKE) docker-up
	$(MAKE) wait-db
	@$(ECHO) "$(YELLOW)Running migrations...$(NC)"
	$(MAKE) migrate
	@$(ECHO) "$(GREEN) ✓ Migrations complete.$(NC)"
	@$(ECHO) "$(YELLOW)Backfilling JWKS...$(NC)"
	OVERWRITE=true $(MAKE) backfill-jwks
	@$(ECHO) "$(GREEN) ✓ Done. Infra is running; start the apps with 'make dev'.$(NC)"

clean:
	@$(ECHO) "$(YELLOW)WARNING: This will remove all docker artifacts, workspace artifacts, and node_modules.$(NC)"
	@read -p "Do you want to proceed with the cleanup? [y/N]: " ans; \
	if [ "$$ans" != "y" ] && [ "$$ans" != "Y" ]; then \
		echo "Skipped cleanup."; \
		exit 0; \
	fi
	@$(ECHO) "$(YELLOW)Cleaning docker artifacts...$(NC)"
	@cd infra && docker compose $(PROFILES) down -v
	@$(ECHO) "$(YELLOW)Cleaning workspace...$(NC)"
	@cd ./services && rm -f go.work go.work.sum || true
	@$(ECHO) "$(YELLOW)Cleaning .next...$(NC)"
	@find . -name ".next" -type d -prune -exec rm -rf '{}' +
	@$(ECHO) "$(YELLOW)Cleaning .turubo...$(NC)"
	@find . -name ".turbo" -type d -prune -exec rm -rf '{}' +
	@$(ECHO) "$(YELLOW)Cleaning node_modules...$(NC)"
	@find . -name "node_modules" -type d -prune -exec rm -rf '{}' +
	@$(ECHO) "$(YELLOW)Cleaning dist...$(NC)"
	@find . -name "dist" -type d -prune -exec rm -rf '{}' +
	@$(ECHO) "$(YELLOW)Cleaning target...$(NC)"
	@find . -name "target" -type d -prune -exec rm -rf '{}' +
	@$(ECHO) "$(YELLOW)Cleaning all synlinked .env files...$(NC)"
	@find . -mindepth 2 -name ".env" -type l -delete
	@echo "Clean complete."
