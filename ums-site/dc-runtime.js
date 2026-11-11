/* Lightweight standalone renderer for the system's page files.
   Pages are stored as source strings in window.DC_SOURCES (see dc-sources.js). */
(function () {
  "use strict";

  var SRC = window.DC_SOURCES || {};
  var defs = {};
  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
  var PART = /\{\{\s*([^}]+?)\s*\}\}/g;

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (p, cb) {
    var next = typeof p === "function" ? p(this.state, this.props) : p;
    this.state = Object.assign({}, this.state, next || {});
    if (this.__inst) this.__inst.schedule();
    if (typeof cb === "function") setTimeout(cb, 0);
  };
  DCLogic.prototype.forceUpdate = function () { if (this.__inst) this.__inst.schedule(); };
  DCLogic.prototype.renderVals = function () { return {}; };
  window.DCLogic = DCLogic;

  function prep(src) {
    return src
      .replace(/<sc-for\b/g, '<template data-sc="for"').replace(/<\/sc-for>/g, "</template>")
      .replace(/<sc-if\b/g, '<template data-sc="if"').replace(/<\/sc-if>/g, "</template>");
  }

  function getDef(name) {
    if (defs[name]) return defs[name];
    var src = SRC[name];
    if (src == null) throw new Error("Missing page source: " + name);
    var doc = new DOMParser().parseFromString(prep(src), "text/html");
    var root = doc.querySelector("x-dc");
    var helmet = root.querySelector("helmet");
    if (helmet) {
      Array.prototype.slice.call(helmet.children).forEach(function (n) {
        var c = document.importNode(n, true);
        c.setAttribute("data-dc-from", name);
        document.head.appendChild(c);
      });
      helmet.parentNode.removeChild(helmet);
    }
    var script = doc.querySelector('script[type="text/x-dc"]');
    var code = script ? script.textContent : "class Component extends DCLogic {}";
    var Cls = new Function("DCLogic", code + "\n;return Component;")(DCLogic);
    defs[name] = { name: name, tpl: root, Cls: Cls };
    return defs[name];
  }

  function lookup(path, scope) {
    path = path.trim();
    if (path === "true") return true;
    if (path === "false") return false;
    if (path === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    if (/^(['"]).*\1$/.test(path)) return path.slice(1, -1);
    var parts = path.split(".");
    var v = scope[parts[0]];
    for (var i = 1; i < parts.length; i++) { if (v == null) return undefined; v = v[parts[i]]; }
    return v;
  }
  function interp(text, scope) {
    return text.replace(PART, function (_, p) { var v = lookup(p, scope); return v == null ? "" : String(v); });
  }
  function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

  function textEvent(el) {
    var t = (el.getAttribute("type") || "text").toLowerCase();
    if (el.localName === "textarea") return "input";
    if (el.localName === "input" && ["checkbox", "radio", "file", "range", "color"].indexOf(t) < 0) return "input";
    return "change";
  }

  function renderNode(node, scope, out, ctx) {
    if (node.nodeType === 3) {
      out.push(document.createTextNode(node.nodeValue.indexOf("{{") >= 0 ? interp(node.nodeValue, scope) : node.nodeValue));
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.localName;

    if (tag === "template" && node.getAttribute("data-sc")) {
      var kind = node.getAttribute("data-sc");
      var kids = node.content.childNodes;
      if (kind === "if") {
        var cond = lookup((WHOLE.exec(node.getAttribute("value") || "") || [, "false"])[1], scope);
        if (cond) for (var i = 0; i < kids.length; i++) renderNode(kids[i], scope, out, ctx);
      } else {
        var list = lookup((WHOLE.exec(node.getAttribute("list") || "") || [, "null"])[1], scope) || [];
        var as = node.getAttribute("as") || "item";
        for (var j = 0; j < list.length; j++) {
          var s = Object.create(scope);
          s[as] = list[j]; s.$index = j;
          for (var k = 0; k < kids.length; k++) renderNode(kids[k], s, out, ctx);
        }
      }
      return;
    }

    if (tag === "dc-import") {
      var ph = document.createElement("dc-child");
      ph.style.display = "contents";
      var props = {};
      Array.prototype.forEach.call(node.attributes, function (a) {
        if (a.name === "name" || a.name.indexOf("hint-") === 0) return;
        var m = WHOLE.exec(a.value);
        props[camel(a.name)] = m ? lookup(m[1], scope) : interp(a.value, scope);
      });
      ph.__childName = node.getAttribute("name");
      ph.__childProps = props;
      out.push(ph);
      return;
    }

    var el = node.namespaceURI && node.namespaceURI !== "http://www.w3.org/1999/xhtml"
      ? document.createElementNS(node.namespaceURI, tag)
      : document.createElement(tag);
    var deferred = {};
    Array.prototype.forEach.call(node.attributes, function (a) {
      var name = a.name, val = a.value;
      if (name.indexOf("hint-") === 0) return;
      var m = WHOLE.exec(val);
      if (name.indexOf("on") === 0 && name.length > 2 && m) {
        var fn = lookup(m[1], scope);
        if (typeof fn === "function") {
          el.__h = el.__h || {};
          var ev = name.slice(2);
          el.__h[ev === "change" ? textEvent(node) : ev] = fn;
        }
        return;
      }
      if (name === "ref") return;
      var raw = m ? lookup(m[1], scope) : (val.indexOf("{{") >= 0 ? interp(val, scope) : val);
      if (name === "value" || name === "checked" || name === "selected") deferred[name] = raw;
      if (typeof raw === "boolean" && (name.indexOf("aria-") === 0 || name.indexOf("data-") === 0)) raw = String(raw);
      if (raw === false || raw == null) return;
      if (raw === true) raw = "";
      try { el.setAttribute(name, String(raw)); } catch (e) {}
    });
    var children = [];
    for (var c = 0; c < node.childNodes.length; c++) renderNode(node.childNodes[c], scope, children, ctx);
    for (var d = 0; d < children.length; d++) el.appendChild(children[d]);
    el.__props = deferred;
    applyProps(el, deferred);
    out.push(el);
  }

  function applyProps(el, p) {
    if (!p) return;
    if ("value" in p) { var v = p.value == null ? "" : String(p.value); if (el.value !== v) el.value = v; }
    if ("checked" in p) el.checked = !!p.checked;
    if ("selected" in p) el.selected = !!p.selected;
  }

  function sameKind(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType === 3) return true;
    if (a.localName !== b.localName || a.namespaceURI !== b.namespaceURI) return false;
    if (a.localName === "dc-child") return a.__childName === b.__childName;
    return true;
  }

  function morphChildren(parent, kids) {
    var i = 0;
    for (; i < kids.length; i++) {
      var old = parent.childNodes[i];
      var nw = kids[i];
      if (!old) parent.appendChild(nw);
      else if (sameKind(old, nw)) morphNode(old, nw);
      else parent.replaceChild(nw, old);
    }
    while (parent.childNodes.length > i) parent.removeChild(parent.lastChild);
  }

  function morphNode(old, nw) {
    if (old.nodeType === 3) { if (old.nodeValue !== nw.nodeValue) old.nodeValue = nw.nodeValue; return; }
    if (old.localName === "dc-child") { old.__childProps = nw.__childProps; old.__dirty = true; return; }
    var oa = old.attributes, na = nw.attributes, k;
    for (k = oa.length - 1; k >= 0; k--) if (!nw.hasAttribute(oa[k].name)) old.removeAttribute(oa[k].name);
    for (k = 0; k < na.length; k++) if (old.getAttribute(na[k].name) !== na[k].value) old.setAttribute(na[k].name, na[k].value);
    old.__h = nw.__h;
    morphChildren(old, Array.prototype.slice.call(nw.childNodes));
    applyProps(old, nw.__props);
  }

  function bindAll(root) {
    var els = root.querySelectorAll("*");
    for (var i = 0; i < els.length; i++) bindOne(els[i]);
  }
  function bindOne(el) {
    {
      if (!el.__h) return;
      el.__bound = el.__bound || {};
      Object.keys(el.__h).forEach(function (type) {
        if (el.__bound[type]) return;
        el.__bound[type] = true;
        el.addEventListener(type, function (e) { var h = el.__h && el.__h[type]; if (h) h(e); });
      });
    }
  }

  function Instance(name, props, container) {
    this.def = getDef(name);
    this.container = container;
    container.__inst = this;
    var logic = new this.def.Cls(props || {});
    logic.props = props || {};
    if (!logic.state) logic.state = {};
    logic.__inst = this;
    this.logic = logic;
    this.render();
    if (typeof logic.componentDidMount === "function") logic.componentDidMount();
  }
  Instance.prototype.schedule = function () {
    var self = this;
    if (self.pending) return;
    self.pending = true;
    Promise.resolve().then(function () { self.pending = false; self.render(); });
  };
  Instance.prototype.setProps = function (p) { this.logic.props = p; this.render(); };
  Instance.prototype.render = function () {
    var vals = this.logic.renderVals() || {};
    var scope = Object.assign(Object.create(null), vals);
    var out = [], tpl = this.def.tpl;
    for (var i = 0; i < tpl.childNodes.length; i++) renderNode(tpl.childNodes[i], scope, out);
    morphChildren(this.container, out);
    bindAll(this.container);
    var kids = this.container.querySelectorAll("dc-child");
    for (var j = 0; j < kids.length; j++) {
      var ph = kids[j];
      if (!ph.__inst) new Instance(ph.__childName, ph.__childProps, ph);
      else if (ph.__dirty) { ph.__dirty = false; ph.__inst.setProps(ph.__childProps); }
    }
  };

  window.DC = { mount: function (name, el) { return new Instance(name, {}, el || document.getElementById("app")); } };
})();
