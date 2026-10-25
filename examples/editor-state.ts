type TEditorStateKey = 'font-size' | 'source' | 'source-pane-width';

const STORAGE_PREFIX = 'mermaid-bpmn-editor.';

export function readEditorState(key: TEditorStateKey): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  } catch {
    return null;
  }
}

export function writeEditorState(key: TEditorStateKey, value: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
  } catch {
    // Storage is optional; keep the current editor state usable if saving fails.
  }
}
