function collectPageText(limit, selectionOnly) {
  const excludedSelector = 'input,textarea,select,script,style,noscript,template,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]';
  if (!document.body) return { text: '', truncated: false };
  const selection = selectionOnly ? window.getSelection() : null;
  if (selectionOnly && (!selection?.rangeCount || selection.isCollapsed)) return { text: '', truncated: false };
  const selectedRange = selection?.getRangeAt(0);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const painted = new WeakMap();
  let text = '';
  let examined = 0;

  function hasPaintedAncestors(element) {
    const checked = [];
    let current = element;
    let visible = true;
    while (current && !painted.has(current)) {
      checked.push(current);
      const style = getComputedStyle(current);
      if (style.opacity === '0' || style.contentVisibility === 'hidden') {
        visible = false;
        break;
      }
      current = current.parentElement;
    }
    visible = visible && painted.get(current) !== false;
    for (const item of checked) painted.set(item, visible);
    return visible;
  }

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (++examined > 18000) return { text, truncated: true };
    if (selectedRange && !selectedRange.intersectsNode(node)) continue;
    const offset = selectedRange?.startContainer === node ? selectedRange.startOffset : 0;
    const end = selectedRange?.endContainer === node ? selectedRange.endOffset : node.length;
    const value = node.data.slice(offset, end).trim().replace(/\s+/g, ' ');
    const element = node.parentElement;
    if (!value || element.closest(excludedSelector) || getComputedStyle(element).visibility !== 'visible' || !hasPaintedAncestors(element)) continue;
    range.selectNodeContents(node);
    if (!range.getClientRects().length) continue;
    text += (text ? '\n' : '') + value;
    if (text.length > limit) return { text: text.slice(0, limit), truncated: true };
  }
  return { text, truncated: false };
}

module.exports = { collectPageText };
