---
name: efficiency
scale: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
pass_threshold: 0.6
applies_to: all
---

Did the agent work toward the result, or waste effort on redundant steps
and back-and-forth?

- 1.0 Direct path; information gathering proportional to the task
- 0.8 One or two small detours that did not cost much
- 0.6 Some detours, recovered quickly
- 0.4 Noticeable spinning: repeated probing or retries before progress
- 0.2 Repeated failed calls or environment probing a skill should cover
- 0.0 The agent never made progress toward the result

Return: score, one-paragraph reason, ids of the events that justify it.
