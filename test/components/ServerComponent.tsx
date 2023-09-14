import type { ComponentChildren } from "react";
import Passthrough, { Foo2 } from "./IslandComponent.tsx";
import { ModalButton } from "./IslandComponent.tsx";
import { cloneElement } from "preact";

export interface FooProps {
  children?: ComponentChildren;
  n: number;
}

function Foo(props: FooProps) {
  return (
    <div
      style={{
        background: "#e6afaf",
        border: "4px solid red",
        borderRadius: ".5rem",
        padding: "1rem",
        margin: "1rem",
      }}
    >
      <h2 className="foobar">This is server component {props.n}</h2>
      <h3 className="foobar">This is server component {props.n}</h3>
      {(Array.isArray(props.children) ? props.children : [props.children])
        .filter((v) => v)
        .map((d) => cloneElement(d))}
    </div>
  );
}

export default function PassthroughPage() {
  return (
    <div style={{ padding: "2rem" }}>
      <h2>Single</h2>
      <Passthrough n={1} depth={0}>
        <Foo n={1} />
      </Passthrough>
      <h2>Nested</h2>
      <Passthrough n={2} depth={0}>
        <Foo n={2}>
          <Passthrough n={3}>
            <Foo n={3}>
              <Passthrough n={4}>
                <Foo n={4} />
              </Passthrough>
            </Foo>
          </Passthrough>
          <Passthrough n={5}>
            <Foo n={5}>
              <Passthrough n={6}>
                <Foo n={6} />
              </Passthrough>
            </Foo>
          </Passthrough>
        </Foo>
      </Passthrough>

      <h2>Modal</h2>
      <ModalButton
        content={
          <div>
            MDR<span>OK LOL</span>
            <Foo2 n={1} depth={0}>
              OK
            </Foo2>
            <Passthrough n={6}>
              <Foo n={6} />
            </Passthrough>
          </div>
        }
      >
        <button>open</button>
      </ModalButton>
    </div>
  );
}
