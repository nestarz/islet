export * from "preact/jsx-runtime";
import { jsx as _jsx } from "preact/jsx-runtime";
import { cloneElement, toChildArray, Fragment } from "preact";
import { createJsx } from "../../server.ts";
export const jsx = createJsx({
  jsx: _jsx,
  cloneElement,
  h: _jsx,
  toChildArray,
  Fragment,
});

export const jsxs = jsx;
