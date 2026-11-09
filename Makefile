# Every target runs inside Docker; the host needs only Docker with Compose.
# UID/GID are exported so bind-mounted files stay owned by the host user (also on CI runners).
export UID ?= $(shell id -u)
export GID ?= $(shell id -g)

COMPOSE := docker compose -f compose.dev.yaml
RUN := $(COMPOSE) run --rm --build dev

.PHONY: mount-points install lint test test-pg build up down dev shell

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

up:
	mkdir -p $(HOME)/.claude/projects $(HOME)/.codex/sessions
	docker compose up -d --build

down:
	docker compose down
	$(COMPOSE) down

dev: mount-points
	$(COMPOSE) run --rm --build --service-ports dev pnpm dev

shell: mount-points
	$(RUN) bash
