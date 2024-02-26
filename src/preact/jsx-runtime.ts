import { jsx as _jsx } from "npm:/preact@10.19/jsx-runtime";
import { cloneElement, Fragment } from "npm:preact@10.19";
import { createJsx } from "./../../server.ts";

export const jsx: (type: any, params: any, key: any, ...props: any[]) => any =
  createJsx({ cloneElement, h: _jsx, Fragment });

export const jsxs: (type: any, params: any, key: any, ...props: any[]) => any =
  jsx;

export { Fragment };
