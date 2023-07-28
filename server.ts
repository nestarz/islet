import {
  fromFileUrl,
  toFileUrl,
  join,
} from "https://deno.land/std@0.196.0/path/mod.ts";
import { denoPlugins } from "https://deno.land/x/esbuild_deno_loader@0.8.1/mod.ts";
import * as esbuild from "https://deno.land/x/esbuild@v0.18.17/wasm.js";
import { IslandDef, getIslands } from "./client.ts";
import {
  scripted,
  collectAndCleanScripts,
  getHashSync,
  storeFunctionExecution,
} from "https://deno.land/x/scripted@0.0.3/mod.ts";
import { createKv, streamToArrayBuffer, streamToJson } from "./src/utils/kv.ts";

export const config = {
  routeOverride: "/islands/:id*",
};

function deepApply<T>(data: T, applyFn): T {
  if (Array.isArray(data)) {
    return (data as unknown[]).map((value) =>
      typeof value === "object" && value !== null
        ? deepApply(value, applyFn)
        : value
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
    const value =
      typeof v === "object" && v !== null ? deepApply(v, applyFn) : v;
    return [key, value];
  });
  return Object.fromEntries(clean) as T;
}

const createCounter = (startAt = 0) => ((i) => () => i++)(startAt) // prettier-ignore

const kv = await createKv();

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
}

const readPlugin = () => ({
  name: "deno_read",
  setup(build) {
    build.onResolve(
      { filter: /^\.(.*)\.(t|j)s(x|)/, namespace: "file" },
      async (args) => {
        const path = await Deno.realPath(
          args.path.startsWith("file")
            ? fromFileUrl(args.path)
            : args.path.startsWith(".")
            ? join(args.resolveDir, args.path)
            : args.path
        );
        return { path, namespace: "file" };
      }
    );
    build.onLoad(
      { filter: /.*\.(t|j)s(x|)/, namespace: "file" },
      async (args) => ({
        contents: await fetch(toFileUrl(args.path)).then((r) => r.text()),
        loader: "tsx",
      })
    );
  },
});

const isDenoDeploy = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;

const esbuildState = ((
  done = false,
  ongoingPromise: null | Promise<null> = null
) => ({
  isInitialized: () => done,
  init: () => {
    if (ongoingPromise) return ongoingPromise;
    const id = initCounter();
    console.time(`[init-${id}] ${esbuild.version}`);
    const wasmURL = `https://raw.githubusercontent.com/esbuild/deno-esbuild/v${esbuild.version}/esbuild.wasm`;
    ongoingPromise = esbuild
      .initialize(isDenoDeploy ? { wasmURL, worker: false } : {})
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
    paths.map(
      async (path) =>
        await kv?.getFile(path).then(async (stream) =>
          output.outputFiles?.push({
            path,
            contents: stream ? await streamToArrayBuffer(stream) : null,
          })
        )
    )
  );
  return output;
};
const savebuild = async (key: string, build: EsBuild) => {
  const paths = build.outputFiles?.map((d) => d.path);
  await Promise.all(
    (build.outputFiles ?? []).map(
      async ({ path, contents }) =>
        await kv
          ?.saveFile(path, contents)
          .catch((e) =>
            console.error(`Error: Saving file to KV failed ${path}\n`, e)
          )
    )
  );
  await Promise.all([
    kv?.saveFile(key, new TextEncoder().encode(JSON.stringify(paths))),
    kv?.housekeep(),
  ]);
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
  if (html instanceof ReadableStream) {
    return html.pipeThrough(new SuffixTransformStream(script));
  }
  return `${html.replace(
    html.includes("</body>") ? /(<\/body>)/ : /(.*)/,
    (_, $1) => `${script}${$1}`
  )}`;
};

const builds: Map<string, Build> = new Map();
const createIslands = async (manifest: Manifest) => {
  const buildConfig: Parameters<typeof esbuild.build>[0] = {
    plugins: [
      readPlugin(),
      ...denoPlugins({
        importMapURL: new URL(
          manifest.importMapFileName ?? "import_map.json",
          manifest.baseUrl
        ).href,
        loader: "portable",
      }),
    ],
    entryPoints: [
      ...Array.from(getIslands(manifest.key ?? "default")).map(
        ([, island]) => ({
          in: island.url,
          out: getHashSync(island.url),
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
  };
  const id = `[esbuild-${buildCounter()}] build`;
  console.time(id);
  const key = getHashSync(JSON.stringify({ buildConfig, id: 3 }));
  const paths = await kv?.getFile(key).then((r) => (r ? streamToJson(r) : r));
  if (!builds.has(key))
    builds.set(
      key,
      paths
        ? await debuild(paths)
        : await savebuild(
            key,
            await esbuildState.init().then(() => esbuild.build(buildConfig))
          )
    );
  console.timeEnd(id);
  return {
    get: (id: string) =>
      builds.get(key)?.outputFiles?.find((d) => d.path.endsWith(id))?.contents,
  };
};

export const createHandler = (manifest: Manifest) => {
  let promise: null | Promise<{
    get: (id: string) => ArrayBuffer | null | undefined;
  }> = null;
  return async (_req: Request, _ctx: any, match: Record<string, string>) => {
    promise ??= createIslands(manifest);
    const islands = await promise;
    const contents = islands.get(match.id);
    return new Response(contents, {
      headers: {
        "content-type": "text/javascript",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  };
};

type HydrateFn = (
  container: Element | Document,
  initialChildren: VNode
) => Root;

const hydrate = (
  node: Element,
  specifier: string,
  exportName: string
): void => {
  const closest = node.parentElement.closest("[data-islet-type=island]");
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

  const getType = async (node: Element) =>
    node.dataset?.isletType === "island"
      ? await import(window._ISLET[node.dataset.isletId].url).then(
          (module) =>
            module[window._ISLET[node.dataset.isletId].exportName ?? "default"]
        )
      : null;

  const toVirtual = async (h, node: Element): Promise<any> => {
    if (node?.nodeType !== 1) return node?.textContent;

    const tagName = node.tagName?.toLowerCase();
    const attributes = processAttributes(node.attributes ?? {});
    const children = await Promise.all(
      [...node.childNodes].map((child) => toVirtual(h, child))
    );

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
        } else if (v?.type)
          return [k, h(v.type, await transformStaticNodeToVirtual(h, v.props))];
        else return [k, v];
      })
    );

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
    // if (withFragment) node.replaceWith(container);
  });
};

const createIslandScript = (prefix: string, { url, exportName }: IslandDef) => {
  const id = getHashSync(url);
  return scripted(hydrate, `${prefix}/islands/${id}.js`, exportName);
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
        const id = getHashSync(component.url);
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
    cloneElement,
    prefix = "",
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
    const isletData = !island
      ? null
      : {
          url: `${prefix}/islands/${getHashSync(island.url)}.js`,
          exportName: island.exportName,
          props: jsonStringifyWithBigIntSupport({
            ...transformVirtualNodeToStatic(params, islands),
            children: undefined,
          }),
        };
    const isletId = island ? getHashSync(JSON.stringify(isletData)) : null;
    if (island)
      storeFunctionExecution((isletId: string, isletData: unknown) => {
        window._ISLET = Object.assign(
          { [isletId]: isletData },
          window._ISLET || {}
        );
      }, ...[isletId, isletData]);
    const className = island ? createIslandScript(prefix, island) : null;
    const children = h(type, params, key, ...props);
    const result = h(island ? "div" : Fragment, {
      style: { display: "contents" },
      className,
      ...(island
        ? { "data-islet-type": "island", "data-islet-id": isletId }
        : {}),
      children: !island
        ? children
        : cloneElement(children, {
            children: children.props.children
              ? [
                  h("div", {
                    style: { display: "contents" },
                    "data-islet-type": "slot",
                    children: children.props.children,
                  }),
                ]
              : null,
          }),
    });
    return island ? result : result.props.children;
  };
