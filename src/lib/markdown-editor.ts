import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--text)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--accent)', fontStyle: 'italic' },
  { tag: tags.strikethrough, color: 'var(--muted)', textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.monospace, color: 'var(--accent)', backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--accent)' },
  { tag: tags.tagName, color: 'var(--accent)', fontWeight: '700' },
  { tag: tags.attributeName, color: 'color-mix(in srgb, var(--text) 72%, var(--accent))' },
  { tag: tags.attributeValue, color: 'var(--green-text)' },
  { tag: tags.angleBracket, color: 'var(--muted)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
]);

const markdownEditorTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'transparent', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  '.cm-content': { padding: '18px 20px', caretColor: 'var(--accent)', lineHeight: '1.8', tabSize: '2' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 3%, transparent)' },
});

export function createMarkdownEditor(
  parent: Element,
  content: string,
  onChange: (content: string) => void,
): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        markdown(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(markdownHighlight),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': '文章正文 Markdown', spellcheck: 'false' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
        markdownEditorTheme,
      ],
    }),
    parent,
  });
}
