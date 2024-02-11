export * from "react/jsx-runtime";
import { jsx as _jsx } from "react/jsx-runtime";
import { cloneElement, Fragment } from "react";
import { createJsx } from "../../server.ts";

export const jsx = createJsx({ cloneElement, h: _jsx, Fragment });
export const jsxs = jsx;
