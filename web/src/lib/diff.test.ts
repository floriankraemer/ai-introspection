import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff.js';

describe('parseDiff', () => {
  it('tells file headers from added and removed lines', () => {
    const kinds = parseDiff(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n',
    ).map((l) => l.kind);
    expect(kinds).toEqual(['file', 'file', 'file', 'hunk', 'del', 'add', 'ctx']);
  });
});
