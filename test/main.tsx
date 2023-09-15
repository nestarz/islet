import * as Islands from "islands/server";
import pipe from "pipe";
import renderToString from "preact-render-to-string";
import { renderToReadableStream } from "react-dom/server?dev";
import { router } from "rutt";
import toReadableStream from "to-readable-stream";
import ServerComponent from "./components/ServerComponent.tsx";

const isReact = Deno.args[0] === "react";
const jsxImportSource = isReact ? "react" : "preact";
const render =
  jsxImportSource === "react"
    ? renderToReadableStream
    : pipe(
        (vn) => "<!DOCTYPE html>".concat(renderToString(vn)),
        (str: string) => new TextEncoder().encode(str),
        toReadableStream
      );

await Deno.serve(
  { port: 8002 },
  router({
    "/": pipe(
      () => <ServerComponent />,
      render,
      Islands.addScripts,
      (body: ReadableStream) =>
        new Response(body, { headers: { "content-type": "text/html" } })
    ),
    [Islands.config.routeOverride]: Islands.createHandler({
      jsxImportSource,
      baseUrl: new URL(import.meta.url),
      prefix: "./islands/",
      importMapFileName: "deno.json",
    }),
  })
).finished;
