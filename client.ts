import type { ComponentType } from "preact";
export type IslandDef = { url: string; exportName: string };
const islands: Map<
  string,
  Map<ComponentType<{ className: string }>, IslandDef>
> = new Map();
export const getIslands = (key: string) => {
  if (!islands.has(key)) islands.set(key, new Map());
  return islands.get(key)!;
};
export default function island<T>(
  fn: ComponentType<{ className: string } & T>,
  url: IslandDef["url"],
  exportName: IslandDef["exportName"] = "default",
  key = "default"
) {
  if (!islands.has(key)) islands.set(key, new Map());
  islands.get(key)?.set(fn, { url, exportName, key });
  return fn;
}
