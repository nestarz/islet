# Islet

Islet is a modern JavaScript library that introduces an architecture for creating fast, scalable, interactive web applications leveraging the Islands Architecture principles. It allows you to create fluent and smooth UI experiences, without being attached to a specific UI library. It's designed to work seamlessly with JSX and supports preact and react for rendering components.


## Main Features

- Implements "Islands Architecture" for creating highly interactive sections of your application
- JSX support for rendering components
- Vendor-agnostic, works well with popular libraries like React and Preact
- Offers flexibility to developers, as components could be declared as "islands", these are parts of the web application which could be independently interacted with, refreshed and updated.

## Hello World in Islands

```tsx
// main.tsx

import * as Islands from "islet/server";
import renderToString from "preact-render-to-string";
import { router } from "rutt";
import pipe from "pipe";

import ServerComponent from "./components/ServerComponent.tsx";

await Deno.serve(
  {
    port: 8002,
  },
  router({
    "/": pipe(
      () => <ServerComponent />,
      renderToString,
      Islands.addScripts,
      (body: ReadableStream | string) =>
        new Response(body, { headers: { "content-type": "text/html" } })
    ),
  })
).finished;
```

Here's an example of an Island component that shows potential through nesting:

```typescript
// IslandComponent.tsx
import island from "islet/client";
import { useState } from "preact/hooks";

interface PassthroughProps {
  children: any;
  n: number;
}

const IslandComponent = island(({ children, n }: PassthroughProps) => {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h2>This is an Island Component #{n}</h2>
      <button onClick={() => setCount((v) => v + 1)}>update {count}</button>
      <div>{children}</div>
    </div>
  );
}, import.meta.url);

export default IslandComponent;
```

Passthrough is a simple Island component, the point here being that it is a higher-order component that wraps other components. The following shows how to use Passthrough in nesting:

```typescript
// ServerComponent.tsx
import Passthrough from "./IslandComponent.tsx";

const Foo = ({ n, children }) => {
  return (
    <div>
      <h2>This is a Server Component #{n}</h2>
      <div>{children}</div>
    </div>
  );
};

const ServerComponent = () => {
  return (
    <div>
      <Passthrough n={1}>
        <Foo n={1} />
      </Passthrough>

      <Passthrough n={2}>
        <Foo n={2}>
          <Passthrough n={3}>
            <Foo n={3} />
          </Passthrough>
        </Foo>
      </Passthrough>
    </div>
  );
};

export default ServerComponent;
```

In the above example, we are rendering a Server component, "Foo", wrapped inside Passthrough components. The Passthrough components are defined as "Island" components due to Islands Architecture. The "Foo" component is a server component. Passthrough components can be nested, and this nesting is where its state is maintained separately from the rest of the application.

## Configuration with Custom JSX-Runtime

To use Islet with custom jsx-runtime in Deno, you need to add specific options in your `deno.json` configuration file. This will determine how JSX is converted into javascript calls. Example for Preact:

```jsonc
{
  "compilerOptions": {
    // ...
    "jsx": "react-jsx",
    "jsxFactory": "createElement",
    "jsxFragmentFactory": "Fragment",
    "jsxImportSource": "islet/preact"
  },
  "imports": {
    "islet/": "https://deno.land/x/islet/",
    "islet/server": "islet/server.ts",
    "islet/client": "islet/client.ts",
    "islet/preact/jsx-runtime": "islet/src/preact/jsx-runtime.ts",
    "islet/react/jsx-runtime": "islet/src/react/jsx-runtime.ts",
    // Preact specific
    "preact-render-to-string": "https://esm.sh/preact-render-to-string@6.2.1?target=es2022&deps=preact@10.16.0",
    "preact": "https://esm.sh/preact@10.16.0?target=es2022",
    "preact/hooks": "https://esm.sh/*preact@10.16.0/hooks?target=es2022",
    "preact/jsx-runtime": "https://esm.sh/*preact@10.16.0/jsx-runtime.js?target=es2022",
    "preact/jsx-dev-runtime": "https://esm.sh/*preact@10.16.0/jsx-dev-runtime.js?target=es2022"
    // ...
  }
}
```
