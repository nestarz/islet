/// <reference lib="deno.unstable" />

import { denoPlugins } from "https://deno.land/x/esbuild_deno_loader@0.8.5/mod.ts";
import {
  collectAndCleanScripts,
  getHashSync,
  scripted,
  storeFunctionExecution,
} from "https://deno.land/x/scripted@0.0.3/mod.ts";
import {
  walk,
  type WalkOptions,
} from "https://deno.land/std@0.213.0/fs/walk.ts";
import {
  dirname,
  join,
  relative,
  toFileUrl,
} from "https://deno.land/std@0.213.0/path/mod.ts";
import { crypto } from "https://deno.land/std@0.213.0/crypto/mod.ts";
import { encodeBase64 } from "https://deno.land/std@0.213.0/encoding/base64.ts";

import { getAllIslands, getIslands, IslandDef } from "./client.ts";

interface Snapshot {
  build_id: string;
  files: Record<string, string[]>;
}

const withWritePermission =
  (await Deno.permissions.query({ name: "write", path: Deno.cwd() })).state ===
    "granted";

const esbuild =
  !withWritePermission || Deno.env.get("FRESH_ESBUILD_LOADER") === "portable"
    ? await import("https://deno.land/x/esbuild@v0.20.0/wasm.js")
    : await import("https://deno.land/x/esbuild@v0.20.0/mod.js");

const buildId = (() => {
  let buildId: string;
  return {
    set: (id: string) => {
      buildId = id;
      console.log("[set-build]", id);
    },
    get: () => {
      if (!buildId) throw Error("Build ID not set");
      return buildId;
    },
  };
})();

const createIslandId = (key: string) =>
  getHashSync(
    [
      buildId.get(),
      new URL(key).protocol === "file:"
        ? relative(Deno.cwd(), new URL(key).pathname)
        : key,
    ]
      .filter((v) => v)
      .join("_"),
  );

export const getIslandUrl = <T>(fn: T, namespace = "default") =>
  `/islands/${createIslandId(getIslands(namespace).data.get(fn)?.url!)}.js`;

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
    data,
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
  namespace?: string;
  baseUrl: URL;
  // islands: URL | URL[];
  prefix: string;
  jsxImportSource: string;
  buildDir?: string;
  importMapFileName?: string;
  esbuildOptions?: Partial<Parameters<typeof esbuild.build>[0]>;
  dev?: boolean;
  walkConfig?: Partial<WalkOptions>;
  useClientReplace?: string;
}

const esbuildState = ((
  done = false,
  ongoingPromise: null | Promise<null | void> = null,
) => ({
  isInitialized: () => done,
  init: () => {
    if (ongoingPromise) return ongoingPromise;
    const id = initCounter();
    console.time(`[init-${id}] ${esbuild.version}`);
    const wasmURL =
      `https://raw.githubusercontent.com/esbuild/deno-esbuild/v${esbuild.version}/esbuild.wasm`;
    ongoingPromise = esbuild
      .initialize(
        !globalThis.Worker || Deno.Command === undefined
          ? { wasmURL, worker: false }
          : {},
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

interface SnapshotReader {
  getPaths: () => string[];
  read: (path: string) => Promise<ReadableStream<Uint8Array> | null>;
  dependencies: (path: string) => string[];
  json: () => {
    [k: string]: string[] | undefined;
  };
}

const buildSnapshot = (bundle: EsBuild): SnapshotReader => {
  const files = new Map<string, Uint8Array>();
  const dependencies = new Map<string, string[]>();
  for (const file of bundle.outputFiles!) {
    files.set(
      relative(Deno.cwd(), toFileUrl(file.path).pathname).split("..").pop()!,
      file.contents,
    );
  }

  const metaOutputs = new Map(Object.entries(bundle.metafile!.outputs));

  for (const [path, entry] of metaOutputs.entries()) {
    const imports = entry.imports
      .filter(({ kind }) => kind === "import-statement")
      .map(({ path }) => path.split("..").pop()!);
    dependencies.set(path.split("..").pop()!, imports);
  }

  return {
    getPaths: () => Array.from(files.keys()),
    read: (path: string) =>
      Promise.resolve(
        files.get(path)
          ? new ReadableStream({
            start(controller) {
              controller.enqueue(files.get(path)!);
              controller.close();
            },
          })
          : null,
      ),
    dependencies: (path: string) => dependencies.get(path) ?? [],
    json: () =>
      Object.fromEntries(
        Array.from(files.keys()).map((key) => [key, dependencies.get(key)]),
      ),
  };
};

const snapshotFromJson = (
  json: Snapshot,
  snapshotDirPath: string,
): SnapshotReader => {
  const dependencies = new Map<string, string[]>(Object.entries(json.files));

  const files = new Map<string, string>();
  Object.keys(json.files).forEach((name) => {
    const filePath = join(snapshotDirPath, name);
    files.set(name, filePath);
  });

  return {
    getPaths: () => Array.from(files.keys()),
    read: async (path: string) => {
      const filePath = files.get(path);
      if (filePath !== undefined) {
        try {
          const file = await Deno.open(join(Deno.cwd(), filePath), {
            read: true,
          });
          return file.readable;
        } catch (_err) {
          return null;
        }
      }

      // Handler will turn this into a 404
      return null;
    },
    dependencies: (path: string) => dependencies.get(path) ?? [],
    json: () =>
      Object.fromEntries(
        Array.from(files.keys()).map((key) => [key, dependencies.get(key)]),
      ),
  };
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
  minify = true,
): Promise<typeof html> => {
  const scripts = collectAndCleanScripts();
  const code = minify ? await transformScript(scripts) : scripts;
  const script = `<script type="module" defer>${code}</script>`;
  if (html instanceof ReadableStream) {
    return html.pipeThrough(new SuffixTransformStream(script));
  }
  return `${
    html.replace(
      html.includes("</body>") ? /(<\/body>)/ : /(.*)/,
      (_, $1) => `${script}${$1}`,
    )
  }`;
};

interface IslandHandlerGetter {
  get: (id: string) => ReturnType<SnapshotReader["read"]>;
}

export const hmrNewIsletSnapshotEventName = "islethmrsnapshotcreated";

const createIslands = async (
  manifest: Manifest,
  initSnapshot: SnapshotReader | null,
  snapshotPath: string,
): Promise<IslandHandlerGetter> => {
  if (initSnapshot) {
    return { get: (id: string) => initSnapshot.read(id) };
  }

  const absWorkingDir = Deno.cwd();
  const buildConfig: Parameters<typeof esbuild.build>[0] = {
    plugins: [
      ...denoPlugins({
        importMapURL: new URL(
          manifest.importMapFileName ?? "deno.json",
          manifest.baseUrl,
        ).href,
      }),
      ...(manifest.esbuildOptions?.plugins ?? []),
    ],
    entryPoints: [
      ...Array.from(getIslands(manifest.namespace ?? "default").data).map(
        ([, island]) => ({
          out: createIslandId(island.url),
          in: island.url,
        }),
      ),
    ],
    platform: "browser",
    target: ["chrome109", "edge116", "firefox115", "ios15.6", "safari15.6"],
    format: "esm",
    jsx: manifest.jsxImportSource ? "automatic" : "transform",
    jsxFactory: "h",
    jsxFragment: "Fragment",
    jsxImportSource: manifest.jsxImportSource,
    bundle: true,
    splitting: true,
    metafile: true,
    treeShaking: true,
    outdir: manifest.prefix,
    absWorkingDir,
    write: false,
    sourcemap: manifest.dev ? "linked" : false,
    minify: true,
    define: {
      ...(manifest.dev ? { "process.env.NODE_ENV": '"development"' } : {}),
      ...manifest.esbuildOptions?.define,
    },
    ...(manifest.esbuildOptions ?? {}),
  };

  const context = await esbuildState
    .init()
    .then(() => esbuild.context(buildConfig));

  const createSnapshotReader = async () => {
    const id = `[esbuild-${buildCounter()}] build`;
    console.time(id);
    const bundle = await context.rebuild();
    console.timeEnd(id);
    const buildDir = dirname(snapshotPath);
    const snapshotReader = buildSnapshot(bundle);
    if (withWritePermission) {
      await Deno.remove(buildDir, { recursive: true }).catch(() => null);
      await Deno.mkdir(buildDir, { recursive: true }).catch(() => null);
      await Promise.all(
        snapshotReader.getPaths().map(async (fileName) => {
          const data = await snapshotReader.read(fileName);
          if (data === null) return;

          const path = join(manifest.buildDir ?? "_islet", fileName);
          await Deno.mkdir(dirname(path), { recursive: true }).catch(
            () => null,
          );

          return Deno.writeFile(path, data);
        }),
      );
      await Deno.writeTextFile(
        snapshotPath,
        JSON.stringify(
          { build_id: buildId.get(), files: snapshotReader.json() },
          null,
          2,
        ),
      );
    }
    return snapshotReader;
  };

  let snapshotReader = await createSnapshotReader();
  if (withWritePermission) {
    globalThis.addEventListener("hmr", async (e) => {
      snapshotReader = await createSnapshotReader();
      console.log("[esbuild] HMR triggered", e.detail.path);
      globalThis.dispatchEvent(
        new CustomEvent(hmrNewIsletSnapshotEventName, { detail: e.detail }),
      );
    });
  } else context.dispose();

  return {
    get: (id: string) => snapshotReader.read(id),
  };
};

type Renderer = {
  h: Function;
  hydrate: HydrateFn;
  withFragment?: boolean;
};

export const createHandler = async (manifest: Manifest) => {
  const promiseCache: Map<string, Promise<IslandHandlerGetter>> = new Map();

  const buildDir = manifest.buildDir ?? "_islet";
  const snapshotPath = join(buildDir, manifest.prefix ?? "", "snapshot.json");
  const json: Snapshot | null = JSON.parse(
    await Deno.readTextFile(snapshotPath).catch(() => "null"),
  );

  if (json?.build_id && !withWritePermission) {
    buildId.set(json.build_id);
  } else {
    const files = [];
    for await (
      const { path } of walk(Deno.cwd(), {
        maxDepth: 10,
        exts: [".js", ".jsx", ".tsx", ".ts", ".json", ".jsonc"],
        ...(manifest.walkConfig ?? {}),
      })
    ) {
      if (!relative(Deno.cwd(), path).startsWith(buildDir)) {
        const file = await Deno.open(path);
        const hash = await crypto.subtle.digest("MD5", file.readable);
        files.push({ url: path, hash: encodeBase64(hash) });
      }
    }
    buildId.set(
      getHashSync(
        JSON.stringify(files.toSorted((a, b) => a.url.localeCompare(b.url))),
      ),
    );
  }

  const snapshot = json?.build_id === buildId.get()
    ? snapshotFromJson(json, buildDir)
    : null;

  if (snapshot) {
    console.log(`Using snapshot (${buildId.get()}) found at ${snapshotPath}`);
  } else if (json && json.build_id !== buildId.get()) {
    console.log(
      `Snapshot (${json.build_id}) found but not up-to-date (${buildId.get()}). Rebuilding...`,
    );
  } else if (!json) console.log(`Snapshot not found.`);

  if (!promiseCache.has(manifest.baseUrl.href)) {
    promiseCache.set(
      manifest.baseUrl.href,
      createIslands(manifest, snapshot, snapshotPath),
    );
  }
  const islands = await promiseCache.get(manifest.baseUrl.href)!;

  return async (_req: Request, _ctx: any, match: Record<string, string>) => {
    const contents = await islands.get(join(manifest.prefix, match.id));
    return contents
      ? new Response(contents, {
        headers: {
          "content-type": "text/javascript",
          "Cache-Control": withWritePermission
            ? "no-cache, no-store, must-revalidate"
            : "public, max-age=31536000, immutable",
        },
      })
      : new Response(null, { status: 404 });
  };
};

type HydrateFn = (
  container: Element | Document,
  initialChildren: VNode,
) => Root;

const hydrate = (
  node: HTMLElement,
  specifier: string,
  exportName: string,
): void => {
  const closest = node.parentElement?.closest("[data-islet-type=island]");
  if (closest) {
    return;
  }

  const parseStyleStr = (styleStr: string): { [key: string]: string } =>
    styleStr
      .split(";")
      .map((style) => style.split(":").map((d) => d.trim()))
      .reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key.replace(/-./g, (x) => x[1].toUpperCase())]: value,
        }),
        {},
      );

  const processAttributes = (
    attributes: NamedNodeMap,
  ): Record<string, unknown> =>
    Array.from(attributes).reduce(
      (acc, { name, value }) => {
        acc[name === "class" ? "className" : name] = name === "style"
          ? parseStyleStr(value)
          : value;
        return acc;
      },
      { key: Math.random() },
    );

  const getType = async (node: HTMLElement) =>
    node.dataset?.isletType === "island"
      ? await import(window._ISLET[node.dataset.isletId].url).then(
        (module) =>
          module[window._ISLET[node.dataset.isletId].exportName ?? "default"],
      )
      : null;

  const toVirtual = async (h, node: Element | null): Promise<any> => {
    if (node?.nodeType === 8) return null;
    if (node?.nodeType !== 1) return node?.textContent;

    const tagName = node.tagName?.toLowerCase();
    const attributes = processAttributes(node.attributes ?? {});
    const children = node.childNodes.length > 0
      ? await Promise.all(
        [...node.childNodes].map((child) => toVirtual(h, child)),
      )
      : null;

    const type = await getType(node);
    if (!type) {
      return tagName === "fragment"
        ? children
        : h(tagName, attributes, children);
    }
    const islandProps = JSON.parse(window._ISLET[node.dataset.isletId].props);
    islandProps.children = await toVirtual(
      h,
      node.querySelector("[data-islet-type]"),
    );
    islandProps.key = Math.random();
    return h(type, islandProps);
  };

  const mapAsync = (arr, fn) => Promise.all(arr.map(async (x) => await fn(x)));

  const transformStaticNodeToVirtual = async (h, props) =>
    Object.fromEntries(
      await mapAsync(Object.entries(props ?? {}), async ([k, v]) => {
        if (v?.__islet && v?.specifier) {
          const [importedV, propsV] = await Promise.all([
            import(v.specifier),
            transformStaticNodeToVirtual(h, v.props),
          ]);
          return [k, h(importedV[v.exportName], propsV)];
        } else if (v?.__islet && v?.type) {
          return [k, h(v.type, await transformStaticNodeToVirtual(h, v.props))];
        } else return [k, v];
      }),
    );

  const renderTask = async () => {
    await import(specifier).then(
      async (module: { [v: string]: string } & Renderer) => {
        const { h, hydrate: rawHydrate, withFragment } = module;
        const type = module[exportName];
        const hydrate = (a: unknown, b: unknown) =>
          rawHydrate.length === 2 ? rawHydrate(a, b) : rawHydrate(b, a);
        const container = withFragment
          ? document.createDocumentFragment()
          : node;
        const children = await toVirtual(
          h,
          node.querySelector("[data-islet-type]")?.dataset.isletType === "slot"
            ? node.querySelector("[data-islet-type]")
            : null,
        );
        const props = JSON.parse(window._ISLET[node.dataset.isletId].props);
        props.children = children;
        const resolvedProps = await transformStaticNodeToVirtual(h, props);
        node.querySelectorAll("[data-islet-type]").forEach((node) => {
          node.replaceWith(...node.childNodes);
        });
        hydrate(h(type, resolvedProps), container);
      },
    );
  };

  "scheduler" in globalThis
    ? globalThis.scheduler!.postTask(renderTask)
    : setTimeout(renderTask, 0);
};

const createIslandScript = ({ url, exportName, islands }: IslandDef) => {
  const id = createIslandId(url);

  return scripted(
    hydrate,
    `${islands.parentPathSegment ?? ""}/islands/${id}.js`,
    exportName,
  );
};

const transformVirtualNodeToStatic = (params, islands) => {
  const newParams = deepApply(
    params,
    (key: string, value: unknown, obj: Record<string, unknown>) => {
      const component = key === "type" &&
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
          __islet: true,
        };
      }
      return key.startsWith("__") ? { ...obj, [key]: undefined } : obj;
    },
  );
  return newParams;
};

const jsonStringifyWithBigIntSupport = (data: unknown) => {
  if (data !== undefined) {
    return JSON.stringify(
      data,
      (_, v) => typeof v === "bigint" ? `${v}#bigint` : v,
    ).replace(/"(-?\d+)#bigint"/g, (_, a) => a);
  }
};

export const setNamespaceParentPathSegment = (
  namespace: string,
  parentPathSegment: string,
) => {
  const islands = getIslands(namespace);
  islands.parentPathSegment = parentPathSegment;
};

// jsx is instancied BY FILE
export const createJsx =
  ({ h, Fragment, cloneElement }) => (type, params, key, ...props) => {
    const islands = getAllIslands();
    const island = islands.get(type);
    const isletData = !island ? null : {
      url: `${island.islands.parentPathSegment ?? ""}/islands/${
        createIslandId(island.url)
      }.js`,
      exportName: island.exportName,
      props: jsonStringifyWithBigIntSupport({
        ...transformVirtualNodeToStatic(params, islands),
        children: undefined,
      }),
    };
    const isletId = island ? getHashSync(JSON.stringify(isletData)) : null;
    if (island) {
      storeFunctionExecution((isletId: string, isletData: unknown) => {
        window._ISLET = Object.assign(
          { [isletId]: isletData },
          window._ISLET || {},
        );
      }, ...[isletId, isletData]);
    }
    const className = island ? createIslandScript(island) : null;
    const children = h(type, params, key, ...props);
    const result = h(
      island ? "fragment" : Fragment,
      {
        ...(island
          ? {
            is: "div",
            "data-islet-type": "island",
            "data-islet-id": isletId,
            style: { display: "contents" },
            class: className,
          }
          : {}),
        children: !island ? children : cloneElement(children, {
          children: children.props.children
            ? h(
              "fragment",
              {
                is: "div",
                style: { display: "contents" },
                "data-islet-type": "slot",
                children: children.props.children,
              },
              children.key,
            )
            : null,
        }),
      },
      children.key,
    );
    return island ? result : result.props.children;
  };
