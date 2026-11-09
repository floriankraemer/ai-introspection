# Configuration reference

Introspect has three kinds of configuration:

- **`.env` variables** are read by Docker Compose when you run `make up`.
  Change them, then run `make up` again.
- **Settings** are changed on the [Settings](11-screen-settings.md) screen and stored in the database.
- **Mounts** connect folders of your computer to the container.
  They are defined in `compose.yaml`.

## `.env` variables

Copy `.env.example` to `.env` to use them.
All are optional.
A variable you leave out keeps its default.

| Variable | Default | Meaning |
|---|---|---|
| `UID`, `GID` | Your user and group id (`id -u`, `id -g`) | The container runs as this user, so files in mounted folders belong to you, not to root. Set them in `.env` only if the defaults are wrong. |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | unset (commits show "Introspect") | The git identity for commits that Introspect makes. Set all four, or none. |
| `INTROSPECT_SKILLS_REPO` | `~/.introspect/skills` | The folder on your computer that Docker mounts as the global skills repo at `/repos/skills`. Choose it once in step 3 of the setup wizard; the mount alone does not. Never use `~/.claude`. |
| `INTROSPECT_PROJECTS_DIR` | `~/.introspect/projects` | The folder with your project repos, one subfolder per repo, mounted at `/repos/projects`. Add each repo in Settings › Skills repositories. |
| `GH_TOKEN` | unset | A GitHub token for pull request mode. Use a fine-grained token limited to your repos, with Contents and Pull requests set to read and write. |
| `TZ` | `UTC` | The time zone, as an IANA name such as `Europe/Berlin`. The daily token budget resets at midnight in this zone, and the monthly budget on the first of the month. |
| `INTROSPECT_PIDS_LIMIT` | `512` | The process limit of the container. |
| `INTROSPECT_MEM_LIMIT` | `2g` | The memory limit of the container. |

These variables exist for tests.
Do not set them for normal use:

| Variable | Effect |
|---|---|
| `INTROSPECT_JUDGE=fake` | Grades with a fake judge. The Health check warns. |
| `INTROSPECT_IMPROVER=fake` | Drafts proposals with a fake improver. |
| `INTROSPECT_NOW=<ISO time>` | Starts the app clock at that time. The Health check warns. |

The host port is fixed at `7317` and bound to `127.0.0.1`.
To change it, edit the `ports` entry in `compose.yaml`.

## Settings

Each setting has a key.
The keys appear in the API and in the Health check.

| Screen label | Key | Default | Allowed values |
|---|---|---|---|
| (set by the wizard) | `setup.completed` | off | on, off |
| **Redact secrets at ingest** | `redaction.enabled` | on | on, off |
| **Extra redaction patterns** | `redaction.custom_patterns` | none | Up to 50 regular expressions |
| **Keep event payloads for (days)** | `retention.days` | 90 | 7 or more |
| **Runs via** | `judge.transport` | **Anthropic API key** | **Anthropic API key**, **Local claude CLI (headless)** |
| **Grade** | `judge.sampling` | **Flagged sessions + 20% random sample** | that, or **Every session** |
| **Budget** | `budget.mode` | **Tokens per day** | **Tokens per day**, **Tokens per day + monthly dollar ceiling**, **Monthly dollar ceiling only** |
| **Daily token budget** | `budget.tokens_per_day` | 1000000 | 1 or more |
| **Monthly ceiling (USD)** | `budget.usd_per_month` | none | 1 or more |
| **Grade sessions** | `schedule.grade` | **When a session ends** | that, or **When its PR merges** |
| **Run improver** | `schedule.improver` | **Daily at 06:00** | that, **Weekly, Monday 06:00**, **Manually** |
| **Accept proposals by** | `proposals.accept_mode` | **Merging locally** | that, or **Opening a pull request** |
| **Compare windows of (days)** | `trends.window_days` | 7 | 1 to 60 |
| **Minimum graded sessions per side** | `trends.min_graded` | 10 | 1 to 1000 |

The Anthropic API key is not a setting.
Introspect stores it in the data volume (`/data/secrets`, file mode 0600).

Each registered repo has two more options, set on the Settings screen:

| Screen label | Meaning |
|---|---|
| The list next to the repo path | Overrides **Accept proposals by** for this repo. **Use default** follows the global value. |
| **Allow hooks, settings and scripts** | Lets proposals change files that Claude Code runs. Off by default. |

## Mounts

| In the container | On your computer | Mode | Purpose |
|---|---|---|---|
| `/sources/claude/projects` | `~/.claude/projects` | read-only | Claude Code session logs |
| `/sources/codex/sessions` | `~/.codex/sessions` | read-only | Codex session logs |
| `/repos/skills` | `INTROSPECT_SKILLS_REPO`, or `~/.introspect/skills` | read-write | The global skills repo, with `rubrics/` |
| `/repos/projects` | `INTROSPECT_PROJECTS_DIR`, or `~/.introspect/projects` | read-write | Project repos that the improver may change |
| `/data` | Docker volume `introspect_data` | read-write | Database, sign-in token, API key, container Claude login (`/data/claude-home`), improver worktrees (`/data/worktrees`) |

No Claude login of yours is mounted.
The container's own login lives in `/data/claude-home`.

`make up` creates the four host folders as your user if they are missing.
Docker on Linux would otherwise create them as root.

To add another session log folder, add a bind mount to `compose.yaml`, run `make up`, and add the container path in Settings (**+ Add source folder**).
