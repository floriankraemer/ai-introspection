# Every target runs inside Docker; the host needs only Docker with Compose.
# UID/GID are exported so bind-mounted files stay owned by the host user (also on CI runners).
export UID ?= $(shell id -u)
export GID ?= $(shell id -g)

COMPOSE := docker compose -f compose.dev.yaml
RUN := $(COMPOSE) run --rm --build dev

.PHONY: mount-points install lint test test-pg build up open doctor claude-login down dev shell

# Host folders mounted into the user stack. Same defaults as compose.yaml; the shell environment
# wins over .env, as it does for Compose.
env_file_value = $(shell sed -n 's/^$(1)=//p' .env 2>/dev/null | tail -n 1)
SKILLS_REPO := $(or $(INTROSPECT_SKILLS_REPO),$(call env_file_value,INTROSPECT_SKILLS_REPO),$(HOME)/.introspect/skills)
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
	docker compose up -d --build --wait

# Prints the URL that signs this browser in.
open:
	docker compose exec introspect introspect open

doctor:
	docker compose exec introspect introspect doctor

# Signs the judge in to Claude, once. The login lives in the container's own home (/data/claude-home),
# never in ~/.claude: a second client of your login could rotate its refresh token and sign you out.
# It prints a URL to open in your browser; paste the code it shows back here.
claude-login:
	docker compose exec -it introspect introspect judge-login

down:
	docker compose down
	$(COMPOSE) down

dev: mount-points
	$(COMPOSE) run --rm --build --service-ports dev pnpm dev

shell: mount-points
	$(RUN) bash
