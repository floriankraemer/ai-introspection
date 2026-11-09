# Requirements

## Computer

| Item | Requirement |
|---|---|
| Operating system | Linux, macOS, or Windows 10 or 11 with WSL2 |
| Docker | Docker Engine, or Docker Desktop, with the Compose plugin (`docker compose version` works) |
| Make | GNU Make. It is preinstalled on most Linux systems and on macOS with the developer tools. On Windows, install it inside WSL2. |
| Git | Needed to clone Introspect. The Docker image contains its own git. |
| Disk space | About 1 GB for the Docker image, plus the database. The database grows with the number of sessions. |
| Browser | Any current browser |
| Network | Internet access, to build the image and to reach the Anthropic API. GitHub access is needed only for pull request mode. |
| Port | `7317` on `127.0.0.1` must be free. |

## Windows with WSL2

Run everything inside the WSL2 Linux system, not in PowerShell.

1. Install WSL2 and a Linux distribution such as Ubuntu.
2. Install Docker Desktop, and turn on **Use the WSL 2 based engine** and the WSL integration for your distribution.
3. Open the Linux terminal and run all commands in this manual there.
4. Clone Introspect into the Linux file system, for example `~/introspect`, and not under `/mnt/c`.
   Git and Docker are much faster there.

Introspect reads `~/.claude/projects` and `~/.codex/sessions` of the Linux home folder where you run `make up`.
Run Claude Code or Codex inside WSL2 as well, so their logs end up in that folder.

## Accounts and keys

You need one of the following to grade sessions.
You can finish the setup without them and add one later.

- An **Anthropic API key**.
  You pay per token, so set a budget (see [Safety and privacy notes](02-safety-and-privacy.md)).
- A **Claude subscription**.
  You sign in once inside the container with `make claude-login`.

Optional:

- A **GitHub token** (`GH_TOKEN`) if you want proposals to open pull requests instead of merging locally.

## Data you need

- At least one folder of agent session logs: `~/.claude/projects` for Claude Code, or `~/.codex/sessions` for Codex.
  If you have used neither tool yet, Introspect starts empty.
- A git repo with your skills and instructions, or an empty folder where the wizard can create one.
