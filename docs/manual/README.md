# Introspect user manual

This manual explains how to install, set up and use Introspect.
It covers the Docker setup first, because that is the supported way to run Introspect.

Read the pages in this order the first time.
After that, use the list below to jump to a task.

## Getting started

1. [Introduction and intended use](01-introduction.md): what Introspect does and what it does not do.
2. [Safety and privacy notes](02-safety-and-privacy.md): what leaves your machine, and what Introspect may change.
   Read this before you start.
3. [Requirements](03-requirements.md): what you need on your computer.
4. [Quick start with Docker](04-quick-start.md): from `git clone` to the first screen in about five minutes.
5. [Setup wizard walkthrough](05-setup-wizard.md): the four steps on first start.

## Daily use

One page per screen:

6. [Sessions](06-screen-sessions.md)
7. [Session detail](07-screen-session-detail.md)
8. [Rubrics](08-screen-rubrics.md)
9. [Proposals](09-screen-proposals.md)
10. [Trends](10-screen-trends.md)
11. [Settings and Health check](11-screen-settings.md)

## Tasks

12. [Writing and calibrating rubrics](12-writing-and-calibrating-rubrics.md)
13. [Reviewing and accepting proposals](13-reviewing-and-accepting-proposals.md)
14. [Reading trends](14-reading-trends.md)

## Reference

15. [Configuration reference](15-configuration-reference.md): `.env` variables, settings, mounts.
16. [Troubleshooting](16-troubleshooting.md): every `introspect doctor` check, and common errors.
17. [Running without Docker](17-running-without-docker.md)
18. [Command reference](18-command-reference.md): `make` targets and the `introspect` command.
19. [Glossary](19-glossary.md)

## For people who maintain this manual

[How to extend the manual](CONTRIBUTING.md) explains how to add a page, how to add a screenshot, and how to regenerate all screenshots with `make manual-screenshots`.

## Conventions in this manual

- Names of buttons, fields, tabs and headings appear exactly as on the screen, for example **Grade selected**.
- `Code font` marks commands, file names, folder paths and setting keys.
- Commands run in a terminal in the Introspect project folder, the folder you get from `git clone`.
- Every procedure has numbered steps.
  Each step is one action and says what you see afterwards.
- A **NOTICE** marks information about your data or about something Introspect changes on disk.
  Nothing in Introspect can injure a person, so no other signal words are used.
- The screenshots come from a demo setup with made-up sessions, a test judge and a fixed date (9 November 2026).
  Your own numbers, names and dates differ.
