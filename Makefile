# Every target runs inside Docker; the host needs only Docker with Compose.
# UID/GID are exported so bind-mounted files stay owned by the host user (also on CI runners).
export UID ?= $(shell id -u)
export GID ?= $(shell id -g)

COMPOSE := docker compose -f compose.dev.yaml
RUN := $(COMPOSE) run --rm --build dev

.PHONY: mount-points install lint test test-pg build up open doctor down dev shell

# Host folders mounted into the user stack. Same defaults as compose.yaml; the shell environment
# wins over .env, as it does for Compose.
env_file_value = $(shell sed -n 's/^$(1)=//p' .env 2>/dev/null | tail -n 1)
SKILLS_REPO := $(or $(INTROSPECT_SKILLS_REPO),$(call env_file_value,INTROSPECT_SKILLS_REPO),$(HOME)/.introspect/skills)
CLAUDE_CREDENTIALS := $(or $(INTROSPECT_CLAUDE_CREDENTIALS),$(call env_file_value,INTROSPECT_CLAUDE_CREDENTIALS),$(HOME)/.claude/.credentials.json)
PROJECTS_DIR := $(or $(INTROSPECT_PROJECTS_DIR),$(call env_file_value,INTROSPECT_PROJECTS_DIR),$(HOME)/.introspect/projects)

# Docker would create these bind-mount points as root if they were missing.
mount-points:
	mkdir -p node_modules web/node_modules

install: mount-points
	$(RUN) pnpm install

lint: mount-points
	$(RUN) pnpm lint

test: mount-points
	$(RUN) pnpm test

test-pg: mount-points
	$(COMPOSE) up -d --wait postgres
	$(RUN) pnpm test:pg

build: mount-points
	$(RUN) pnpm build

# Created here as your user: the Docker engine on Linux would create missing mount points as root.
up:
	mkdir -p $(HOME)/.claude/projects $(HOME)/.codex/sessions "$(SKILLS_REPO)" "$(PROJECTS_DIR)"
	@# A file bind mount needs its source; an empty file means "not logged in" (never a directory Docker makes as root).
	@[ -e "$(CLAUDE_CREDENTIALS)" ] || { mkdir -p "$$(dirname "$(CLAUDE_CREDENTIALS)")" && install -m 600 /dev/null "$(CLAUDE_CREDENTIALS)"; }
	docker compose up -d --build --wait

# Prints the URL that signs this browser in.
open:
	docker compose exec introspect introspect open

doctor:
	docker compose exec introspect introspect doctor

down:
	docker compose down
	$(COMPOSE) down

dev: mount-points
	$(COMPOSE) run --rm --build --service-ports dev pnpm dev

shell: mount-points
	$(RUN) bash
