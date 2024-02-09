export const namespace = "main";

export const isReact = !!(<div />).$$typeof;

export default async (url: string) => {
  const { hydrate } = isReact
    ? await import("react-dom/client").then((module) => ({
      hydrate: module.default.hydrateRoot,
    }))
    : await import("preact");

  const { h, toChildArray } = isReact
    ? await import("react").then((
      { default: { createElement: h, Children } },
    ) => ({
      h,
      toChildArray: Children.toArray,
    }))
    : await import("preact");
  if (!globalThis.document) {
    const island = (await import("islet/client")).default;
    island(url, namespace);
  }

  return { h, hydrate, toChildArray };
};
