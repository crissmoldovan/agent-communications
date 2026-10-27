// A small local stand-in for the Design canvas's runtime, so these prototype screens open in any browser from a static
// server, with no Claude account. It understands only what these files use:
// - {{holes}} in text and attributes;
// - <sc-if value>, and <sc-for list as> with $index;
// - on* handlers returned by renderVals();
// - <helmet>, whose links and styles move to the page's head;
// - the defaults in data-props, each of which a query parameter can override (?theme=dark&jevState=on).
(function () {
  'use strict';

  let render = null;
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => {
      queued = false;
      if (render) render();
    });
  }

  class DCLogic {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
      this.state = Object.assign({}, this.state, next);
      schedule();
    }
    forceUpdate() {
      schedule();
    }
  }

  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;

  function lookup(expr, scope) {
    const e = expr.trim();
    if (e === 'true') return true;
    if (e === 'false') return false;
    if (e === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
    let v = scope;
    for (const part of e.split('.')) {
      if (v == null) return undefined;
      v = v[part];
    }
    return v;
  }

  function whole(text) {
    const m = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/.exec(text);
    return m ? m[1] : null;
  }

  function interpolate(text, scope) {
    return text.replace(HOLE, (_, e) => {
      const v = lookup(e, scope);
      return v == null ? '' : String(v);
    });
  }

  function setAttribute(el, name, value, scope) {
    const hole = whole(value);
    if (/^on[a-z]/.test(name)) {
      const fn = hole == null ? null : lookup(hole, scope);
      if (typeof fn === 'function') el.addEventListener(name.slice(2), fn);
      return;
    }
    if (hole == null) {
      el.setAttribute(name, value.includes('{{') ? interpolate(value, scope) : value);
      return;
    }
    const v = lookup(hole, scope);
    if (name.startsWith('aria-')) {
      el.setAttribute(name, String(v == null ? false : v));
    } else if (v === true) {
      el.setAttribute(name, '');
    } else if (v !== false && v != null) {
      el.setAttribute(name, String(v));
    }
  }

  function expand(node, scope, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(interpolate(node.nodeValue, scope)));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.localName;
    if (tag === 'helmet') return;
    if (tag === 'sc-if') {
      const hole = whole(node.getAttribute('value') || '');
      if (hole != null && lookup(hole, scope)) for (const c of node.childNodes) expand(c, scope, out);
      return;
    }
    if (tag === 'sc-for') {
      const hole = whole(node.getAttribute('list') || '');
      const as = node.getAttribute('as') || 'item';
      const list = (hole != null && lookup(hole, scope)) || [];
      list.forEach((item, index) => {
        const inner = Object.create(scope);
        inner[as] = item;
        inner.$index = index;
        for (const c of node.childNodes) expand(c, inner, out);
      });
      return;
    }
    const el = document.createElementNS(node.namespaceURI, node.localName);
    for (const a of Array.from(node.attributes)) setAttribute(el, a.name, a.value, scope);
    const source = tag === 'template' ? node.content : node;
    for (const c of source.childNodes) expand(c, scope, el);
    out.appendChild(el);
  }

  function readProps(script) {
    const spec = JSON.parse(script.getAttribute('data-props') || '{}');
    const props = {};
    for (const [key, entry] of Object.entries(spec)) {
      if (key.startsWith('$') || !entry || !('default' in entry)) continue;
      props[key] = entry.default;
    }
    for (const [key, raw] of new URLSearchParams(location.search)) {
      props[key] = raw === 'true' ? true : raw === 'false' ? false : raw;
    }
    return props;
  }

  function boot() {
    const host = document.querySelector('x-dc');
    const script = document.querySelector('script[data-dc-script]');
    if (!host || !script) return;
    const template = document.createElement('template');
    template.innerHTML = host.innerHTML;
    const helmet = template.content.querySelector('helmet');
    if (helmet) for (const c of Array.from(helmet.children)) document.head.appendChild(c.cloneNode(true));
    const base = document.createElement('style');
    base.textContent = 'x-dc{display:block}';
    document.head.appendChild(base);
    const Component = new Function('DCLogic', `${script.textContent}\nreturn Component;`)(DCLogic);
    const instance = new Component(readProps(script));
    if (!instance.state) instance.state = {};
    render = () => {
      const fragment = document.createDocumentFragment();
      const values = instance.renderVals();
      for (const c of template.content.childNodes) expand(c, values, fragment);
      host.replaceChildren(fragment);
    };
    render();
  }

  window.DCLogic = DCLogic;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
