import { readEditorState, writeEditorState } from './editor-state';

export function initializeEditorSourceContent(
  source: HTMLTextAreaElement,
  defaultContent: string,
  render: (content: string) => void | Promise<void>,
  clearPreview: () => void,
) {
  const clearButton = source.ownerDocument.getElementById('source-clear') as HTMLButtonElement;
  let timer: ReturnType<typeof setTimeout> | undefined;

  source.value = readEditorState('source') || defaultContent;

  function refresh() {
    clearTimeout(timer);
    if (source.value.trim()) {
      render(source.value);
    } else {
      clearPreview();
    }
  }

  function setContent(content: string) {
    source.value = content;
    writeEditorState('source', source.value);
    refresh();
  }

  function handleInput() {
    writeEditorState('source', source.value);
    clearTimeout(timer);
    // Render once the user pauses typing; save each edit immediately.
    timer = setTimeout(refresh, 250);
  }

  function clear() {
    setContent('');
    source.focus();
  }

  source.addEventListener('input', handleInput);
  clearButton.addEventListener('click', clear);

  return { setContent, refresh };
}
