# Reading trends

The [Trends](10-screen-trends.md) screen answers one question: did my change help?
This page explains what the chart and the verdicts mean, and when to trust them.

## Read the chart

1. Open **Trends** and set **Rubric** to one rubric.

   The chart shows one line.
   With **All rubrics**, lines that follow the same values lie on top of each other.

2. Look at the points.

   Each point is a pass rate for one week (or day, with **Group by** set to **Days**).
   A **hollow point** has fewer than 5 graded sessions.
   Treat it as a hint, not a result.

3. Look for markers.

   | Marker | Meaning |
   |---|---|
   | Dashed vertical line with a dot (**Merged change**) | You accepted a proposal, or someone edited a skill or instruction file in a registered repo. |
   | Hollow diamond (**Baseline reset**) | A rubric or the judge model changed. |
   | Dashed horizontal line (**Target**) | The pass rate you aim for. The default is 70 %. |

4. Compare the line before and after a marker.

   The chart gives a first impression.
   The change log, below the chart, gives the verdict.

## Baseline resets

A rubric text or the judge model decides what counts as a pass.
When one of them changes, the pass rates before and after are not like-for-like.
A **Baseline reset** marker tells you to read the line as two separate series.
Do not conclude that the new rubric made your agent better or worse because the line moved at that marker.

The reference set reduces this problem.
Introspect grades its pinned sessions again after every reset, so you can compare the same sessions under the old and new rubric.

## Read the change log

Each row of **Did the fix help?** compares the 7 days before a change with the 7 days after it.
The window is **Compare windows of (days)** in [Settings](11-screen-settings.md).

| Verdict | Meaning in plain words |
|---|---|
| **Improved** | The pass rate rose, and the rise is unlikely to be chance. |
| **Worse** | The pass rate fell, and the fall is unlikely to be chance. |
| **No change** | The pass rate moved a little or not at all, or it moved by an amount you could get by chance. This does not prove that the change had no effect. |
| **Too early — N graded since** | There are not enough graded sessions yet, before or after the change. Wait, and grade more sessions. |

"Too early" appears when either side has fewer graded sessions than **Minimum graded sessions per side**.
The default is 10.
The text shows how many sessions were graded since the change.

### The detection limit

A small number of sessions can only show a large difference.
With 10 graded sessions on each side, a difference needs to be about 40 to 50 percentage points to count as improved or worse.
A jump from 60 % to 80 % is not enough.

The tests behind the verdicts are standard statistics:

- Introspect tests each rubric separately.
- Below 30 sessions per side it uses Fisher's exact test, which suits small groups.
  From 30 on, it uses a z-test.
- It asks for 90 % confidence.
- When a change targets several rubrics, it corrects for the number of tests (the Holm method), so one lucky rubric is not enough to call a change a success.
- It counts distinct sessions.
  Grading the same session twice does not add a sample.

To detect smaller improvements, collect more sessions:

1. Wait longer before you read the verdict.

   More sessions are graded on each side.

2. Raise **Compare windows of (days)** in Settings.

   Each side covers more days, up to 60.

3. Raise **Minimum graded sessions per side** if you want verdicts only when a lot of data exists.

   Small samples then show "Too early".

## Manual edits

Introspect also marks edits you make yourself, in the global skills repo and in registered project repos.
It finds them by scanning every 15 minutes, or when you run `introspect scan`.
Its own merges and pull requests are not counted twice.
The Health check shows a "Change tracking" warning when the scan cannot follow a repo, for example after a rewritten git history.

## Common questions

**The chart is empty.**
No sessions are graded for the chosen **Range**.
Grade sessions on the [Sessions](06-screen-sessions.md) screen, or choose **Last 26 weeks**.

**The verdict says "Too early" for a long time.**
You grade few sessions per week.
Set **Grade** to **Every session** in Settings, or lower the minimum.
A lower minimum makes verdicts less reliable.

**The pass rate improved, but the verdict says "No change".**
The difference is within what chance can produce.
Wait for more sessions.

**Two changes landed in the same week.**
The window before the second change contains the first.
Read the rows together and avoid crediting one change.
