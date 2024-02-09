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

const islands: Map<string, IslandDef["islands"]> = new Map();

export const getIslands = (namespace: string) => {
  if (!islands.has(namespace)) {
    islands.set(namespace, { loading: true, data: new Map() });
  }
  return islands.get(namespace)!;
};

export const getAllIslands = () =>
  Array.from(islands.values()).reduce((combined, map) => {
    return new Map([...combined, ...map.data]);
  }, new Map());

export default function island(url: IslandDef["url"], namespace = "default") {
  if (globalThis.document) return null;

  if (!islands.has(namespace)) {
    islands.set(namespace, { loading: true, data: new Map() });
  }
  (async () => {
    const module = await import(url);
    Object.entries(module).map(([exportName, value]) => {
      islands.get(namespace)?.data.set(value, {
        url,
        exportName,
        namespace,
        islands: islands.get(namespace)!,
      });
    });
  })()
    .catch(console.error)
    .finally(() => (islands.get(namespace)!.loading = false));
}
