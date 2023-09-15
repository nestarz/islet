const isReact = Deno.args[0] === "react";
const { jsx, jsxs, Fragment, jsxDEV } = isReact
  ? await import("islands/react/jsx-runtime")
  : await import("islands/preact/jsx-runtime");
export { jsx, jsxs, jsxDEV, Fragment };
