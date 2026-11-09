# Introspect — every target runs inside Docker; the host needs only Docker with Compose.
# Run `make` (or `make help`) for the grouped list. Targets are documented with `## text`,
# groups with `##@ Name`; the help screen is generated from these comments.

# UID/GID are exported so bind-mounted files stay owned by the host user (also on CI runners).
export UID ?= $(shell id -u)
export GID ?= $(shell id -g)

.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose -f compose.dev.yaml
RUN := $(COMPOSE) run --rm --build dev
APP := docker compose exec introspect introspect

# Host folders mounted into the user stack. Same defaults as compose.yaml; the shell environment
# wins over .env, as it does for Compose.
env_file_value = $(shell sed -n 's/^$(1)=//p' .env 2>/dev/null | tail -n 1)
SKILLS_REPO := $(or $(INTROSPECT_SKILLS_REPO),$(call env_file_value,INTROSPECT_SKILLS_REPO),$(HOME)/.introspect/skills)
PROJECTS_DIR := $(or $(INTROSPECT_PROJECTS_DIR),$(call env_file_value,INTROSPECT_PROJECTS_DIR),$(HOME)/.introspect/projects)

# Colours for the help screen; empty when stdout is not a terminal (CI logs stay clean).
ifneq ($(shell test -t 1 && echo tty),)
  BOLD := \033[1m
  CYAN := \033[36m
  YELLOW := \033[33m
  DIM := \033[2m
  RESET := \033[0m
endif

##@ Help

.PHONY: help
help: ## Show this list
	@printf "\n$(BOLD)Introspect$(RESET) $(DIM)— all commands run in Docker$(RESET)\n"
	@printf "Usage: $(CYAN)make <target>$(RESET) $(DIM)[VAR=value]$(RESET)\n"
	@awk 'BEGIN {FS = ":.*## "} \
		/^##@/ { printf "\n$(YELLOW)%s$(RESET)\n", substr($$0, 5); next } \
		/^[a-zA-Z0-9_-]+:.*## / { printf "  $(CYAN)%-20s$(RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf "\n$(DIM)Manual: docs/manual/README.md$(RESET)\n\n"

##@ Run the app

.PHONY: up down restart status logs open doctor claude-login rotate-token
# Mount points are created here as your user: the Docker engine on Linux would create them as root.
up: ## Build and start Introspect on http://localhost:7317
	@docker rm -f introspect-dev >/dev/null 2>&1 || true
	mkdir -p $(HOME)/.claude/projects $(HOME)/.codex/sessions "$(SKILLS_REPO)" "$(PROJECTS_DIR)"
	docker compose up -d --build --wait

down: ## Stop Introspect and the dev containers (data is kept)
	docker compose down
	$(COMPOSE) down

restart: ## Restart Introspect without rebuilding
	docker compose restart introspect

status: ## Show the containers and their health
	docker compose ps

logs: ## Follow the app logs (Ctrl+C to stop)
	docker compose logs -f --tail=200 introspect

open: ## Print the sign-in link for your browser
	$(APP) open

doctor: ## Run the health check (same as Settings › Health check)
	$(APP) doctor

# The login lives in the container's own home (/data/claude-home), never in ~/.claude: a second
# client of your login could rotate its refresh token and sign you out on the host.
claude-login: ## Sign the judge in to Claude once (CLI transport)
	docker compose exec -it introspect introspect judge-login

rotate-token: ## Issue a new sign-in token; old links and cookies stop working
	$(APP) rotate-token

##@ Work with your data

.PHONY: import grade improve scan
import: ## Import all session history now
	$(APP) import

grade: ## Grade sessions now (ARGS="--since 7d" | "--session <id>" | "--all")
	$(APP) grade $(or $(ARGS),--since 1d)

improve: ## Run the improver now (ARGS="--since 24h")
	$(APP) improve --now $(ARGS)

scan: ## Look for changes in the skills repos now (trends markers)
	$(APP) scan

##@ Develop

.PHONY: mount-points install dev shell gen-api format
# Docker would create these bind-mount points as root if they were missing.
mount-points:
	@mkdir -p node_modules web/node_modules

install: mount-points ## Install dependencies (pnpm, in the dev container)
	$(RUN) pnpm install

# The dev server takes port 7317 from the user stack, so that stack is stopped first.
dev: mount-points ## Start server (7317) and Vite (5173) with live reload
	@docker compose stop introspect 2>/dev/null || true
	@docker rm -f introspect-dev >/dev/null 2>&1 || true
	$(COMPOSE) run --rm --build --service-ports --name introspect-dev dev pnpm dev

shell: mount-points ## Open a shell in the dev container
	$(RUN) bash

gen-api: mount-points ## Regenerate the SPA's API types from docs/api/openapi.json
	$(RUN) pnpm --filter web gen:api

format: mount-points ## Format all files with Prettier
	$(RUN) pnpm exec prettier --write .

##@ Test and check

.PHONY: lint test test-pg build check e2e e2e-update audit
lint: mount-points ## ESLint, Prettier check, type check, module rules
	$(RUN) pnpm lint

test: mount-points ## Unit and integration tests (SQLite) plus web tests
	$(RUN) pnpm test

test-pg: mount-points ## Postgres tests and the NFR-05 benchmarks
	$(COMPOSE) up -d --wait postgres
	$(RUN) pnpm test:pg

build: mount-points ## Build the server and the SPA
	$(RUN) pnpm build

check: lint test test-pg build ## Everything CI runs except e2e

# Throwaway app with a fake judge and improver, seeded sessions and a Playwright container
# (compose.e2e.yaml). The stack is removed afterwards, also on failure. Traces: e2e/.work/results.
e2e: ## Browser end-to-end tests in Docker
	e2e/run.sh

e2e-update: ## Run e2e and rewrite the screenshot baselines
	e2e/run.sh --update

audit: mount-points ## Check production dependencies for known vulnerabilities
	$(RUN) pnpm audit --prod

##@ Docs

.PHONY: manual-screenshots
manual-screenshots: ## Regenerate the manual's screenshots (docs/manual/images)
	e2e/run.sh --manual
