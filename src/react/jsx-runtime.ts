import * as JSX from "npm:@types/react@18.2/jsx-runtime";

import { cloneElement, Fragment } from "react";
import { createJsx } from "./../../server.ts";

export const jsx: (type: any, params: any, key: any, ...props: any[]) => any =
  createJsx({ cloneElement, h: (JSX as any).jsx, Fragment });

export const jsxs: (type: any, params: any, key: any, ...props: any[]) => any =
  jsx;

export { Fragment };
