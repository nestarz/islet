const isReact = Deno.args[0] === "react";
const { jsx, jsxs, Fragment, jsxDEV } = isReact
  ? await import("islet/react/jsx-runtime")
  : await import("islet/preact/jsx-runtime");
export { jsx, jsxs, jsxDEV, Fragment };
