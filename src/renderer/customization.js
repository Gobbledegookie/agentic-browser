(function () {
  'use strict';

  const styleRoots = '#titlebarBackdrop, #brand, #topTabs, #toolbar, #bookmarkBar, #findBar, #sideTabs, #page, #panelBody[data-customizable]';
  const scopedRuleTypes = new Set(['CSSStyleRule', 'CSSMediaRule', 'CSSSupportsRule', 'CSSContainerRule', 'CSSNestedDeclarations']);
  const htmlTags = new Set(('a abbr address article aside b bdi bdo blockquote br caption code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img kbd li main mark ol p pre q s samp section small span strong style sub summary sup table tbody td tfoot th thead time tr u ul var wbr').split(' '));
  const htmlAttributes = new Set(['alt', 'class', 'colspan', 'datetime', 'dir', 'height', 'id', 'lang', 'open', 'role', 'rowspan', 'style', 'title', 'width']);
  const rasterDataUrl = /^data:image\/(?:avif|bmp|gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i;
  let activeSheet = null;

  function cssRuleIsScoped(rule) {
    if (!scopedRuleTypes.has(rule.constructor.name)) return false;
    // Electron treats these declarations as native window hit regions.
    rule.style?.removeProperty('app-region');
    rule.style?.removeProperty('-webkit-app-region');
    return !rule.cssRules || [...rule.cssRules].every(cssRuleIsScoped);
  }

  function applyCss(source) {
    const otherSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== activeSheet);
    activeSheet = null;
    if (source.trim()) {
      const parsed = new CSSStyleSheet();
      parsed.replaceSync(source);
      const allowedRules = [...parsed.cssRules].filter(cssRuleIsScoped).map((rule) => rule.cssText);
      if (allowedRules.length) {
        const scoped = new CSSStyleSheet();
        scoped.replaceSync('@scope (' + styleRoots + ') {\n' + allowedRules.join('\n') + '\n}');
        activeSheet = scoped;
      }
    }
    document.adoptedStyleSheets = activeSheet ? [...otherSheets, activeSheet] : otherSheets;
  }

  function copyPassiveMarkup(source, target) {
    for (const item of source.childNodes) {
      if (item.nodeType === Node.TEXT_NODE) {
        target.append(document.createTextNode(item.textContent));
        continue;
      }
      if (item.nodeType !== Node.ELEMENT_NODE || item.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !htmlTags.has(item.localName)) continue;

      const element = document.createElement(item.localName);
      for (const { name, value } of item.attributes) {
        const safeHref = item.localName === 'a' && name === 'href' && value.startsWith('#');
        const safeImage = item.localName === 'img' && name === 'src' && rasterDataUrl.test(value);
        if (htmlAttributes.has(name) || /^aria-[a-z-]+$/.test(name) || safeHref || safeImage) element.setAttribute(name, value);
      }
      copyPassiveMarkup(item, element);
      target.append(element);
    }
  }

  function buildNewTabDocument(source) {
    const untrusted = document.createElement('template');
    untrusted.innerHTML = source;
    const passive = document.createElement('template');
    copyPassiveMarkup(untrusted.content, passive.content);
    const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
    const baseStyle = ':root{color-scheme:dark light;font:16px/1.5 "Segoe UI",sans-serif}body{margin:24px}img{max-width:100%}';
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="' + csp + '"><style>' + baseStyle +
      '</style></head><body>' + passive.innerHTML + '</body></html>';
  }

  window.relayAppearance = { applyCss, buildNewTabDocument };
})();
