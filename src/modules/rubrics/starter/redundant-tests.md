---
name: redundant-tests
scale: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
pass_threshold: 0.6
applies_to: sessions that add or change tests
---

Did the tests the agent wrote or ran add coverage, or did they duplicate
existing coverage and ignore the project's test-pyramid rule?

- 1.0 Every new test covers behaviour that no other test covers, at the lowest sensible level
- 0.8 One test overlaps existing coverage
- 0.6 A few overlapping tests, but the important behaviour is covered
- 0.4 Several tests assert the same behaviour at different levels
- 0.2 Most new tests duplicate coverage, or end-to-end tests replace cheap unit tests
- 0.0 The test suite was run or extended repeatedly with no new coverage

Return: score, one-paragraph reason, ids of the events that justify it.
