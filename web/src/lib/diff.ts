export type DiffKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx';

/** Classifies each line of a unified diff; the last empty line a trailing newline leaves is dropped. */
export function parseDiff(diff: string): { kind: DiffKind; text: string }[] {
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text) => {
    let kind: DiffKind = 'ctx';
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|rename )/.test(text)) kind = 'file';
    else if (text.startsWith('@@')) kind = 'hunk';
    else if (text.startsWith('+')) kind = 'add';
    else if (text.startsWith('-')) kind = 'del';
    return { kind, text };
  });
}
