export type IslandDef = {
  url: string;
  exportName: string;
  namespace?: "default" | string;
  islands: {
    loading: boolean;
    data: Map<any, IslandDef>;
    parentPathSegment?: string | undefined;
  };
};

const getPrivateIslands: () => Map<string, IslandDef["islands"]> =
  ((value = new Map<string, IslandDef["islands"]>()) => () => value)();

export const getIslands = (namespace: string): {
  loading: boolean;
  data: Map<any, IslandDef>;
  parentPathSegment?: string | undefined;
} => {
  if (!getPrivateIslands().has(namespace)) {
    getPrivateIslands().set(namespace, { loading: true, data: new Map() });
  }
  return getPrivateIslands().get(namespace)!;
};

export const getAllIslands = (): Map<any, any> =>
  Array.from(getPrivateIslands().values()).reduce((combined, map) => {
    return new Map([...combined, ...map.data]);
  }, new Map());

export default function island(
  url: IslandDef["url"],
  namespace = "default",
): null | undefined {
  if (globalThis.document) return null;

  if (!getPrivateIslands().has(namespace)) {
    getPrivateIslands().set(namespace, { loading: true, data: new Map() });
  }
  (async () => {
    const module = await import(url);
    Object.entries(module).map(([exportName, value]) => {
      getPrivateIslands().get(namespace)?.data.set(value, {
        url,
        exportName,
        namespace,
        islands: getPrivateIslands().get(namespace)!,
      });
    });
  })()
    .catch(console.error)
    .finally(() => (getPrivateIslands().get(namespace)!.loading = false));
}
