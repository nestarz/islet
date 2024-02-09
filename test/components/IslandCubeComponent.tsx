import { isReact } from "../use_client.tsx";
import Passthrough from "./IslandComponent.tsx";

const { useState } = isReact
  ? (await import("react")).default
  : await import("preact/compat");

export const { h, hydrate, toChildArray } = await import("../use_client.tsx")
  .then(
    (v) => v.default(import.meta.url),
  );

export default ({
  depth,
  children,
  className,
  n,
}: {
  children: any;
  n: number;
}) => {
  const [v, set] = useState(0);
  return (
    <div
      className={className}
      style={{
        background: "yellow",
        padding: "1rem",
        border: "4px solid blue",
        borderRadius: ".5rem",
        margin: "1rem",
      }}
    >
      <h2>This is an Island Cube #{n}</h2>
      <button onClick={() => set((v2) => (v2 + 1) % 4)}>update {v}</button>
      <div style={{ padding: "1rem 0" }}>{v < 2 && children}</div>
      <Passthrough><Passthrough>OK</Passthrough></Passthrough>
    </div>
  );
};
