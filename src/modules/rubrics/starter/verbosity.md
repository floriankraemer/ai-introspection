---
name: verbosity
scale: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
pass_threshold: 0.6
applies_to: all
---

Are the agent's chat replies and code comments as short as they can be
while staying complete?

- 1.0 Replies state the result and the open questions; comments explain only what the code cannot
- 0.8 Mostly concise; one reply or comment is longer than needed
- 0.6 Some restating of the task or the diff, but easy to skim
- 0.4 Long summaries that repeat what the user already sees in the diff
- 0.2 Noisy comments on obvious code, or multi-section reports for small changes
- 0.0 Replies and comments bury the result

Return: score, one-paragraph reason, ids of the events that justify it.
