/// <reference lib="deno.unstable" />
import { HTMLRewriter } from "https://raw.githubusercontent.com/worker-tools/html-rewriter/db2bd9803f/index.ts";
import { denoPlugins } from "https://deno.land/x/esbuild_deno_loader@0.8.1/mod.ts";
import * as esbuild from "https://deno.land/x/esbuild@v0.19.2/wasm.js";
import { getIslands, IslandDef } from "./client.ts";
import {
  collectAndCleanScripts,
  getHashSync,
  storeFunctionExecution,
} from "https://deno.land/x/scripted@0.0.3/mod.ts";
import * as kvUtils from "https://deno.land/x/kv_toolbox@0.0.3/blob.ts";
import { Element } from "https://deno.land/x/lol_html@0.0.6/lol_html.js";
import {
  type VNode,
  type ComponentChildren,
} from "https://esm.sh/preact@10.17.1";

type H = (
  type: string | ((args: any) => VNode),
  props: unknown,
  ...children: ComponentChildren[]
) => VNode;

const kv = await Deno.openKv();
const buildId = Deno.env.get("DENO_DEPLOYMENT_ID") || Math.random().toString();
const createIslandId = (key: string) =>
  getHashSync([buildId, key].filter((v) => v).join("_"));
const calcKvKey = (key: string) => ["_islet", buildId, key];

export const config = {
  routeOverride: "/islands/:id*",
};

function deepApply<T>(data: T, applyFn): T {
  function isObject(object: unknown): object is Record<keyof never, unknown> {
    return object instanceof Object && object.constructor === Object;
  }
  if (Array.isArray(data)) {
    return (data as unknown[]).map((value) =>
      isObject(value) ? deepApply(value, applyFn) : value
    ) as unknown as T;
  }
  const entries = Object.entries(data as Record<string, unknown>).reduce(
    (p, [key, value]) => {
      const r = applyFn(key, value, p);
      return r;
    },
    data
  );
  const clean = Object.entries(entries).map(([key, v]) => {
    const value = isObject(v) ? deepApply(v, applyFn) : v;
    return [key, value];
  });
  return Object.fromEntries(clean) as T;
}

const createCounter = (startAt = 0) => ((i) => () => i++)(startAt); // prettier-ignore

const initCounter = createCounter(0);
const buildCounter = createCounter(0);
const transformCounter = createCounter(0);

class SuffixTransformStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(suffix: string) {
    super({
      flush(controller) {
        controller.enqueue(new TextEncoder().encode(suffix));
        controller.terminate();
      },
    });
  }
}

export interface Manifest {
  key?: string;
  baseUrl: URL;
  // islands: URL | URL[];
  prefix: string;
  jsxImportSource: string;
  importMapFileName?: string;
  esbuildOptions?: Partial<Parameters<typeof esbuild.build>[0]>;
}

const isDenoDeploy = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;

const esbuildState = ((
  done = false,
  ongoingPromise: null | Promise<null | void> = null
) => ({
  isInitialized: () => done,
  init: () => {
    if (ongoingPromise) return ongoingPromise;
    const id = initCounter();
    console.time(`[init-${id}] ${esbuild.version}`);
    const wasmURL = `https://raw.githubusercontent.com/esbuild/deno-esbuild/v${esbuild.version}/esbuild.wasm`;
    ongoingPromise = esbuild
      .initialize(
        isDenoDeploy || !globalThis.Worker ? { wasmURL, worker: false } : {}
      )
      .then(() => {
        done = true;
        console.timeEnd(`[init-${id}] ${esbuild.version}`);
      })
      .catch((err) =>
        err.toString().includes("more than once") ? null : console.error(err)
      );

    return ongoingPromise!;
  },
}))();

type EsBuild = Awaited<ReturnType<typeof esbuild.build>>;
type Build = {
  outputFiles: {
    path: string;
    contents: ArrayBuffer | null | undefined;
  }[];
};

const debuild = async (paths: string[]) => {
  const output: Build = {
    outputFiles: [],
  };
  await Promise.all(
    paths.map((path) =>
      kvUtils
        .get(kv, calcKvKey(path))
        .then((contents) => output.outputFiles?.push({ path, contents }))
    )
  );
  return output;
};

const savebuild = async (key: string, build: EsBuild) => {
  const paths = build.outputFiles?.map((d) => d.path);
  Promise.all(
    (build.outputFiles ?? []).map(({ path, contents }) =>
      kvUtils
        .set(kv, calcKvKey(path), contents)
        .catch((e) =>
          console.error(`Error: Saving file to KV failed ${path}\n`, e)
        )
    )
  );

  console.time("[island] saving");
  await kvUtils
    .set(kv, calcKvKey(key), new TextEncoder().encode(JSON.stringify(paths)))
    .catch(console.error)
    .then(async () => {
      for await (const iterator of kv.list({ prefix: ["_islet"] }))
        if (!iterator.key.includes(buildId))
          await kv.delete(iterator.key).catch(console.error);
    })
    .finally(() => console.timeEnd("[island] saving"));

  return await debuild(paths!);
};

const transformScript = async (script: string) => {
  esbuildState.init().catch(console.error);
  if (!esbuildState.isInitialized()) return script;
  const id = `[esbuild-${transformCounter()}] transform`;
  console.time(id);
  const scripts = await esbuild.transform(script, { minify: true });
  console.timeEnd(id);
  return scripts.code;
};

export const addScripts = async (
  html: string | ReadableStream,
  minify = true
): Promise<typeof html> => {
  const scripts = collectAndCleanScripts();
  const code = minify ? await transformScript(scripts) : scripts;
  const script = `<script type="module" defer>${code}</script>`;
  const isReadable = html instanceof ReadableStream;
  const response = new HTMLRewriter()
    .on("islet", {
      element: (elt) =>
        elt.replace(`<!--${elt.getAttribute("data-islet")}-->`, { html: true }),
    })
    .on("body", { element: (elt) => elt.append(script, { html: true }) })
    .transform(new Response(html));
  return isReadable ? response.body : await response.text();
};

const builds: Map<string, Build> = new Map();
const createIslands = async (manifest: Manifest) => {
  const buildConfig: Parameters<typeof esbuild.build>[0] = {
    plugins: [
      ...denoPlugins({
        importMapURL: new URL(
          manifest.importMapFileName ?? "import_map.json",
          manifest.baseUrl
        ).href,
        loader: isDenoDeploy ? "portable" : "native",
      }),
    ],
    entryPoints: [
      ...Array.from(getIslands(manifest.key ?? "default")).map(
        ([, island]) => ({
          in: island.url,
          out: createIslandId(island.url),
        })
      ),
    ],
    format: "esm",
    jsx: manifest.jsxImportSource ? "automatic" : "transform",
    jsxFactory: "h",
    jsxFragment: "Fragment",
    jsxImportSource: manifest.jsxImportSource,
    bundle: true,
    splitting: true,
    treeShaking: true,
    write: false,
    outdir: manifest.prefix,
    sourcemap: "linked",
    minify: true,
    ...(manifest.esbuildOptions ?? {}),
  };
  const id = `[esbuild-${buildCounter()}] build`;
  console.time(id);
  const key = getHashSync(JSON.stringify({ buildConfig }));
  const pathsBin = await kvUtils.get(kv, calcKvKey(key));
  const paths = pathsBin
    ? JSON.parse(new TextDecoder().decode(pathsBin))
    : pathsBin;
  if (!builds.has(key)) {
    builds.set(
      key,
      paths
        ? await debuild(paths)
        : await savebuild(
            key,
            await esbuildState.init().then(() => esbuild.build(buildConfig))
          )
    );
  }
  console.timeEnd(id);
  return {
    get: (id: string) =>
      builds.get(key)?.outputFiles?.find((d) => d.path.endsWith(id))?.contents,
  };
};

export const createHandler = (manifest: Manifest) => {
  const promiseCache: Map<
    string,
    Promise<{ get: (id: string) => ArrayBuffer | null | undefined }>
  > = new Map();
  return async (_req: Request, _ctx: any, match: Record<string, string>) => {
    if (!promiseCache.has(manifest.baseUrl.href))
      promiseCache.set(manifest.baseUrl.href, createIslands(manifest));
    const islands = await promiseCache.get(manifest.baseUrl.href)!;
    const contents = islands.get(match.id);
    return contents
      ? new Response(contents, {
          headers: {
            "content-type": "text/javascript",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        })
      : new Response(null, { status: 404 });
  };
};

type HydrateFn = (
  container: Element | Document,
  initialChildren: VNode
) => Root;

const hydrate = (
  node: HTMLElement,
  specifier: string,
  exportName: string
): void => {
  const closest = node.parentElement?.closest("[data-islet-type=island]");
  if (closest) return;

  const parseStyleStr = (styleStr: string): { [key: string]: string } =>
    styleStr
      .split(";")
      .map((style) => style.split(":").map((d) => d.trim()))
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});

  const processAttributes = (
    attributes: NamedNodeMap
  ): Record<string, unknown> =>
    Array.from(attributes).reduce(
      (acc, { name, value }) => {
        acc[name === "class" ? "className" : name] =
          name === "style" ? parseStyleStr(value) : value;
        return acc;
      },
      { key: Math.random() }
    );

  const getType = async (node: HTMLElement) =>
    node.dataset?.isletType === "island"
      ? await import(window._ISLET[node.dataset.isletId].url).then(
          (module) =>
            module[window._ISLET[node.dataset.isletId].exportName ?? "default"]
        )
      : null;

  const toVirtual = async (h, node: Element | null): Promise<any> => {
    if (node?.nodeType !== 1) return node?.textContent;

    const tagName = node.tagName?.toLowerCase();
    const attributes = processAttributes(node.attributes ?? {});
    const children =
      node.childNodes.length > 0
        ? await Promise.all(
            [...node.childNodes].map((child) => toVirtual(h, child))
          )
        : null;

    const type = await getType(node);
    if (!type) return h(tagName, attributes, children);

    const islandProps = JSON.parse(window._ISLET[node.dataset.isletId].props);
    islandProps.children = await toVirtual(
      h,
      node.querySelector("[data-islet-type]")
    );

    return h(tagName, attributes, h(type, islandProps));
  };

  const mapAsync = (arr, fn) => Promise.all(arr.map(async (x) => await fn(x)));

  const transformStaticNodeToVirtual = async (h, props) =>
    Object.fromEntries(
      await mapAsync(Object.entries(props), async ([k, v]) => {
        if (v?.specifier) {
          const [importedV, propsV] = await Promise.all([
            import(v.specifier),
            transformStaticNodeToVirtual(h, v.props),
          ]);
          return [k, h(importedV[v.exportName], propsV)];
        } else if (v?.type) {
          return [k, h(v.type, await transformStaticNodeToVirtual(h, v.props))];
        } else return [k, v];
      })
    );

  const renderTask = () =>
    import(specifier).then(async (o: { h: typeof h; hydrate: HydrateFn }) => {
      const { h, hydrate: rawHydrate, withFragment } = o;
      const type = o[exportName];
      const hydrate = (a: unknown, b: unknown) =>
        rawHydrate.length === 2 ? rawHydrate(a, b) : rawHydrate(b, a);
      const container = withFragment ? document.createDocumentFragment() : node;
      const children = await toVirtual(
        h,
        node.querySelector("[data-islet-type]")
      );
      const props = JSON.parse(window._ISLET[node.dataset.isletId].props);
      props.children = children;
      const resolvedProps = await transformStaticNodeToVirtual(h, props);
      hydrate(h(type, resolvedProps), container);
    });

  "scheduler" in globalThis
    ? globalThis.scheduler!.postTask(renderTask)
    : setTimeout(renderTask, 0);
};

interface HierarchyItem<T> {
  id: string;
  parent?: string | null;
  children?: (T & HierarchyItem<T>)[];
}
type Slot = { begin: Comment; end: Comment; id: string; slotId: string };
type Islet = {
  id: string;
  dataId: string;
  parent: string | null;
  begin: Comment; // from the DOM
  end: Comment; // from the DOM
  children?: Islet[];
  slots: Record<string, Slot>;
};

const hydrateComment = (specifier: string, id: string): void => {
  const parseStyleStr = (styleStr: string): { [key: string]: string } =>
    styleStr
      .split(";")
      .map((style) => style.split(":").map((d) => d.trim()))
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});

  const processAttributes = (
    attributes: NamedNodeMap
  ): Record<string, unknown> =>
    Array.from(attributes).reduce(
      (acc, { name, value }) => {
        acc[name === "class" ? "className" : name] =
          name === "style" ? parseStyleStr(value) : value;
        return acc;
      },
      { key: Math.random() }
    );

  function formHierarchy<T extends HierarchyItem<T>>(
    data: T[]
  ): (T & HierarchyItem<T>)[] {
    const map = new Map(data.map((item: T) => [item.id, { ...item }]));
    data.forEach((item: T) => {
      const parent = map.get(item.parent!);
      if (parent) {
        parent.children = parent.children ?? [];
        parent.children.push(item);
      }
    });
    return Array.from(map.values()).filter((item: T) => item.parent === null);
  }

  const parseComment = (
    node
  ): { id: string; begin: boolean; end: boolean; type: "slot" | "island" } =>
    JSON.parse(
      new DOMParser().parseFromString(node.nodeValue, "text/html")
        .documentElement?.textContent
    );

  const getIslets = (root: HTMLElement): Islet[] => {
    const array: Islet[] = [];
    let parent: string | null = null;
    let node: Comment | null;
    const filter = NodeFilter.SHOW_COMMENT;
    const iterator = document.createNodeIterator(root, filter, null);
    while ((node = iterator.nextNode() as Comment)) {
      const { begin, end, dataId, id, type, slotId } = parseComment(node);
      if (begin && type === "island") {
        array.push({ id, dataId, begin: node, end: node, parent, slots: {} });
        parent = id;
      }
      const islet = array
        .slice()
        .reverse()
        .find((v) => v.id === id);
      if (islet && end && type === "island")
        (islet.end = node), (parent = islet.parent || null);
      if (begin && type === "slot" && islet)
        islet.slots[slotId] = { id, begin: node, end: node, slotId };
      if (end && type === "slot" && islet) islet.slots[slotId].end = node;
    }
    return array;
  };

  function* nodesBetween(startNode: Node, endNode: Node) {
    for (
      let next = startNode.nextSibling;
      next && next !== endNode;
      next = next.nextSibling
    )
      yield next;
  }

  function duplicate(startNode: Node, endNode: Node) {
    const fragment = document.createDocumentFragment();
    fragment.append(
      ...Array.from(nodesBetween(startNode, endNode)).map((d) =>
        d.cloneNode(true)
      )
    );
    return fragment;
  }

  function replaceNodes(startNode: Node, endNode: Node, ...newNodes: Node[]) {
    const parent = startNode.parentNode;
    while (startNode.nextSibling && startNode.nextSibling !== endNode)
      parent?.removeChild(startNode.nextSibling);
    const fragment = document.createDocumentFragment();
    newNodes.forEach((node) => fragment.appendChild(node));
    parent?.insertBefore(fragment, endNode);
  }

  const getType = async (islet: Islet) =>
    await import(window._ISLET[islet.dataId].url).then(
      (module) => module[window._ISLET[islet.dataId].exportName ?? "default"]
    );

  const getAll = (nodes, islets) => {
    let result = [];
    let lastId = undefined;
    for (let x of nodes) {
      const isletStart = islets.find((islet) => islet.begin === x);
      const isletEnd = islets.find(
        (islet) => islet.end === x && islet.id === lastId
      );
      if (isletStart || !lastId) result.push(x);
      if (isletStart) lastId = isletStart.id;
      if (isletEnd) lastId = null;
    }
    return result;
  };

  const toVirtual = async (
    h: H,
    node: Node,
    islets: Islet[]
  ): Promise<VNode | string | null> => {
    const islet = islets.find(({ begin }) => begin === node);
    if (islet) {
      const type = await getType(islet);
      const isletData = window._ISLET[islet.dataId];
      const islandProps = {
        ...JSON.parse(isletData.props),
        ...Object.fromEntries(
          await Promise.all(
            isletData.slots.map(async (key) => [
              key,
              await Promise.all(
                getAll(
                  nodesBetween(islet.slots[key].begin, islet.slots[key].end),
                  islets
                ).map((node) => toVirtual(h, node, islets))
              ),
            ])
          )
        ),
      };
      return h(type, islandProps);
    }
    if (node?.nodeType === 8) return null;
    if (node?.nodeType !== 1) return node?.textContent;
    const childNodes = getAll(Array.from(node.childNodes), islets);
    const children = await Promise.all(
      childNodes.map((node) => toVirtual(h, node, islets))
    );
    const elt = node as unknown as Element;
    const tagName = elt.tagName?.toLowerCase();
    const attributes = processAttributes(elt.attributes ?? {});
    return h(tagName, attributes, children);
  };

  window._ISLETS = window._ISLETS ?? getIslets(document.documentElement);
  const renderTask = () => {
    const islets: ReturnType<typeof getIslets> = window._ISLETS;
    const islet = islets.find((v) => v.id === id);
    if (!islet || islet?.parent) return;

    import(specifier).then(async (o: { h: typeof h; hydrate: HydrateFn }) => {
      const { h, hydrate: rawHydrate } = o;
      const hydrate = (a: unknown, b: unknown) =>
        rawHydrate.length === 2 ? rawHydrate(a, b) : rawHydrate(b, a);
      const container = duplicate(islet.begin, islet.end);
      const staticVNode = await toVirtual(h, islet.begin, islets);
      hydrate(staticVNode, container);
      replaceNodes(islet.begin, islet.end, container);
    });
  };

  setTimeout(
    () =>
      "scheduler" in globalThis
        ? globalThis.scheduler!.postTask(renderTask)
        : setTimeout(renderTask, 0),
    1000
  );
};

const createIslandScriptComment = (
  prefix: string,
  { url }: IslandDef,
  isletId
) => {
  const id = createIslandId(url);
  return storeFunctionExecution(
    hydrateComment,
    `${prefix}/islands/${id}.js`,
    isletId
  );
};

const transformVirtualNodeToStatic = (params, islands) => {
  const newParams = deepApply(
    params,
    (key: string, value: unknown, obj: Record<string, unknown>) => {
      const component =
        key === "type" &&
        islands.get(value?.type ?? value) &&
        typeof value === "function"
          ? islands.get(value?.type ?? value)
          : null;
      if (component) {
        const id = createIslandId(component.url);
        return {
          ...obj,
          [key]: value,
          specifier: `/islands/${id}.js`,
          exportName: component.exportName,
        };
      }
      return key.startsWith("__") ? { ...obj, [key]: undefined } : obj;
    }
  );
  return newParams;
};

const jsonStringifyWithBigIntSupport = (data: unknown) => {
  if (data !== undefined) {
    return JSON.stringify(data, (_, v) =>
      typeof v === "bigint" ? `${v}#bigint` : v
    ).replace(/"(-?\d+)#bigint"/g, (_, a) => a);
  }
};

export const createJsx =
  ({
    jsx,
    h,
    Fragment,
    prefix = "",
    isValidElement,
    cloneElement,
    toChildArray,
    key: islandKey = "default",
  }) =>
  (
    type: Parameters<typeof jsx>[0],
    params: Parameters<typeof jsx>[1],
    key: Parameters<typeof jsx>[2],
    ...props
  ) => {
    const islands = getIslands(islandKey);
    const island = islands.get(type);
    const children = h(type, params, key, ...props);
    if (!island) return children;

    const isletData = !island
      ? null
      : {
          url: `${prefix}/islands/${createIslandId(island.url)}.js`,
          exportName: island.exportName,
          slots: Object.entries(params)
            .filter(([_key, value]) => isValidElement(value))
            .map(([key]) => key),
          props: jsonStringifyWithBigIntSupport({
            ...params,
            ...Object.fromEntries(
              Object.entries(params)
                .filter(([_key, value]) => isValidElement(value))
                .map(([key]) => [key, undefined])
            ),
          }),
        };

    const isletDataId = island ? getHashSync(JSON.stringify(isletData)) : null;
    storeFunctionExecution((isletDataId: string, isletData: unknown) => {
      window._ISLET = Object.assign(
        { [isletDataId]: isletData },
        window._ISLET || {}
      );
    }, ...[isletDataId, isletData]);
    const isletId = getHashSync(Math.random().toString());
    createIslandScriptComment(prefix, island, isletId);

    const newProps = {};
    for (const [key, value] of Object.entries(children.props)) {
      if (toChildArray(value).some((value) => isValidElement(value)))
        newProps[key] = toChildArray(value).flatMap((value) =>
          !isValidElement(value)
            ? value
            : [
                h("islet", {
                  "data-islet": JSON.stringify({
                    id: isletId,
                    dataId: isletDataId,
                    type: "slot",
                    slotId: key,
                    begin: true,
                  }),
                }),
                value,
                h("islet", {
                  "data-islet": JSON.stringify({
                    id: isletId,
                    dataId: isletDataId,
                    type: "slot",
                    slotId: key,
                    end: true,
                  }),
                }),
              ]
        );
    }

    return h(Fragment, {
      children: [
        h("islet", {
          "data-islet": JSON.stringify({
            id: isletId,
            dataId: isletDataId,
            begin: true,
            type: "island",
          }),
        }),
        cloneElement(children, newProps),
        h("islet", {
          "data-islet": JSON.stringify({
            id: isletId,
            dataId: isletDataId,
            end: true,
            type: "island",
          }),
        }),
      ],
    });
  };
