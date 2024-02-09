import { isReact } from "../use_client.tsx";
import IslandCubeComponent from "./IslandCubeComponent.tsx";

const { useState, useEffect, Fragment, cloneElement } = isReact
  ? (await import("react")).default
  : await import("preact/compat");
const { createPortal } = isReact
  ? (await import("react-dom")).default
  : await import("preact/compat");

export const { h, hydrate, toChildArray } = await import(
  "../use_client.tsx"
).then((v) => v.default(import.meta.url));

interface PassthroughProps {
  children: any;
  n: number;
}

export default function Passthrough({
  depth,
  children,
  className,
  n,
}: PassthroughProps) {
  const [v, set] = useState(0);
  return (
    <div
      className={className}
      style={{
        background: "#85efac",
        padding: "1rem",
        border: "4px solid blue",
        borderRadius: ".5rem",
        margin: "1rem",
      }}
    >
      <h2>This is an Island #{n}</h2>
      <button onClick={() => set((v2) => (v2 + 1) % 4)}>update {v}</button>
      <div style={{ padding: "1rem 0" }}>{v < 2 && children}</div>
    </div>
  );
}

export const TestIslandCube = ({ className }) => {
  return (
    <section className={className}>
      <IslandCubeComponent />
    </section>
  );
};

const container = globalThis.document?.body.appendChild(
  Object.assign(document.createElement("div")),
);

export const Modal = ({ open, onClose, children }) => {
  useEffect(() => {
    const onKeyDown = (e: Event) => (e.key === "Escape" ? onClose() : null);
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.addEventListener("keydown", onKeyDown);
  });
  return (
    open &&
    container &&
    createPortal(
      <Fragment>
        <button onClick={onClose} type="button" />
        {children}
        <button onClick={onClose} type="button">
          ✗
        </button>
      </Fragment>,
      container,
    )
  );
};

export const ModalButton = ({ children, content }) => {
  const [index, setIndex] = useState<number | null>(null);
  return (
    <Fragment>
      {toChildArray(children).map((children) =>
        cloneElement(children, {
          onClick: () => {
            setIndex(0);
          },
        })
      )}
      <Modal open={typeof index === "number"} onClose={() => setIndex(null)}>
        {content}
      </Modal>
    </Fragment>
  );
};
