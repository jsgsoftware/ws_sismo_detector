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