export * from "react/jsx-runtime";
import { jsx as _jsx } from "react/jsx-runtime";
import {
  Children,
  cloneElement,
  createElement as h,
  isValidElement,
} from "react";
import { createJsx } from "../../server.ts";

export const jsx = createJsx({
  jsx: _jsx,
  cloneElement,
  h: _jsx,
  toChildArray: Children.toArray,
  isValidElement
});

export const jsxs = jsx;
