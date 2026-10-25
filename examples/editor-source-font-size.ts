const SOURCE_FONT_SIZES = [0.6, 0.725, 0.85, 0.975, 1.1];
const DEFAULT_SOURCE_FONT_SIZE_INDEX = 2;

export function initializeEditorSourceFontSize(source: HTMLTextAreaElement) {
  const sourceFontDecrease = source.ownerDocument.getElementById('source-font-decrease') as HTMLButtonElement;
  const sourceFontIncrease = source.ownerDocument.getElementById('source-font-increase') as HTMLButtonElement;
  const sourceFontReset = source.ownerDocument.getElementById('source-font-reset') as HTMLButtonElement;
  let sourceFontSizeIndex = DEFAULT_SOURCE_FONT_SIZE_INDEX;

  function setSourceFontSize(index: number) {
    sourceFontSizeIndex = Math.max(0, Math.min(index, SOURCE_FONT_SIZES.length - 1));
    source.style.fontSize = `${SOURCE_FONT_SIZES[sourceFontSizeIndex]}rem`;
    sourceFontDecrease.disabled = sourceFontSizeIndex === 0;
    sourceFontIncrease.disabled = sourceFontSizeIndex === SOURCE_FONT_SIZES.length - 1;
  }

  sourceFontDecrease.addEventListener('click', () => setSourceFontSize(sourceFontSizeIndex - 1));
  sourceFontIncrease.addEventListener('click', () => setSourceFontSize(sourceFontSizeIndex + 1));
  sourceFontReset.addEventListener('click', () => setSourceFontSize(DEFAULT_SOURCE_FONT_SIZE_INDEX));
  setSourceFontSize(DEFAULT_SOURCE_FONT_SIZE_INDEX);
}
