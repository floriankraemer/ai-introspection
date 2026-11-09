import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

// Colours are the design tokens, so light and dark follow the theme without a second palette.
const theme = EditorView.theme({
  '&': {
    color: 'var(--ink)',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: '8px',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '2px' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
    minHeight: '17rem',
    maxHeight: '32rem',
  },
  '.cm-content': { padding: '12px', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
});

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--ink-muted)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--accent)' },
  { tag: [t.number, t.bool, t.string, t.atom], color: 'var(--pass-ink)' },
  { tag: t.monospace, color: 'var(--warn-ink)' },
  { tag: t.link, color: 'var(--accent)', textDecoration: 'underline' },
]);

/** CodeMirror 6 in markdown mode (or plain text), with the `---` YAML frontmatter highlighted as YAML. */
export default function MarkdownEditor({
  value,
  onChange,
  label,
  plain = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  /** No markdown highlighting: for diffs and other text where `- ` is not a list. */
  plain?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!host.current) return;
    // CodeMirror injects its styles as <style> elements, which the server's CSP (default-src 'self')
    // blocks. In a shadow root it adopts a constructable stylesheet instead, which the CSP allows.
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
    const v = new EditorView({
      parent: root,
      root,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          ...(plain
            ? []
            : [yamlFrontmatter({ content: markdown() }), syntaxHighlighting(highlight)]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true' }),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
    };
    // Created once; later `value` changes are applied by the effect below.
  }, []);

  // External changes (another rubric selected, threshold input rewrote the frontmatter).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} data-testid="markdown-editor" />;
}
