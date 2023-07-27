export * from "react/jsx-runtime";
import { jsx as _jsx } from "react/jsx-runtime";
import { Children, createElement as h, cloneElement, Fragment } from "react";
import { createJsx } from "../../server.ts";

export const jsx = createJsx({
  jsx: _jsx,
  cloneElement,
  h: _jsx,
  toChildArray: Children.toArray,
  Fragment,
});

export const jsxs = jsx;
