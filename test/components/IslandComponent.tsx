import island from "islands/client";
const isReact = !!(<div />).$$typeof;
export const { h, toChildArray } = isReact
  ? await import("react").then(({ createElement: h, Children }) => ({
      h,
      toChildArray: Children.toArray,
    }))
  : await import("preact");
const { useState, useEffect, Fragment, cloneElement } = isReact
  ? await import("react")
  : await import("preact/compat");
const { createPortal } = isReact
  ? await import("react-dom")
  : await import("preact/compat");
export const { hydrate } = isReact
  ? await import("react-dom/client?dev").then((module) => ({
      hydrate: module.hydrateRoot,
    }))
  : await import("preact");

interface PassthroughProps {
  children: any;
  n: number;
}

export const Foo2 = island(
  () => {
    const [v, set] = useState(0);
    return (
      <button onClick={() => set((v2) => (v2 + 1) % 4)}>FOO2 update {v}</button>
    );
  },
  import.meta.url,
  "Foo2"
);

export default island(function Passthrough({
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
},
import.meta.url);

const container = globalThis.document?.body.appendChild(
  Object.assign(document.createElement("div"))
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
      container
    )
  );
};

export const ModalButton = island(
  ({ children, content }) => {
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
        {content}
        <Modal open={typeof index === "number"} onClose={() => setIndex(null)}>
          {content}
        </Modal>
      </Fragment>
    );
  },
  import.meta.url,
  "ModalButton"
);
