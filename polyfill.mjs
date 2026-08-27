import { DOMParser, Element, Node, Document } from '@xmldom/xmldom';

global.DOMParser = DOMParser;
global.Element = Element;
global.Node = Node;
global.Document = Document;

global.HTMLElement = class HTMLElement {
  constructor() {}
  attachShadow() {
    return { appendChild() {}, querySelector() { return null; } };
  }
  appendChild() {}
  querySelector() {
    return null;
  }
  addEventListener() {}
  removeEventListener() {}
  get textContent() {
    return '';
  }
  set textContent(v) {}
};

global.customElements = {
  define() {},
  get() {
    return undefined;
  },
};