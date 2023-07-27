const BUILD_ID = Deno.env.get("DENO_DEPLOYMENT_ID") ?? Math.random().toString();

export const createKv = (buildId?: string) => {
  const chunksize = 65536;
  const namespace = ["_frsh", "js", buildId ?? BUILD_ID];

  // @ts-ignore as `Deno.openKv` is still unstable.
  const kvPromise = Deno.openKv?.();

  if (!kvPromise) return null;

  return {
    getFile: async (file: string) => {
      const kv = await kvPromise;
      const filepath = [...namespace, file];
      const metadata = await kv.get(filepath);

      if (metadata.versionstamp === null) {
        return null;
      }

      return new ReadableStream<Uint8Array>({
        start: async (sink) => {
          for await (const chunk of kv.list({ prefix: filepath })) {
            sink.enqueue(chunk.value as Uint8Array);
          }
          sink.close();
        },
      });
    },
    saveFile: async (file: string, content: Uint8Array) => {
      const kv = await kvPromise;
      const filepath = [...namespace, file];
      const metadata = await kv.get(filepath);

      let chunks = 0;
      const totalChunks = Math.ceil(content.length / chunksize);

      while (chunks < totalChunks) {
        let transaction = kv.atomic();

        for (
          let i = 0;
          i < 10 && chunks * chunksize < content.length;
          i++, chunks++
        ) {
          transaction = transaction.set(
            [...filepath, chunks],
            content.slice(chunks * chunksize, (chunks + 1) * chunksize)
          );
        }

        // Commit the transaction every 10 operations
        await transaction.commit();
      }

      // Update the metadata with the number of chunks
      const result = await kv
        .atomic()
        .set(filepath, chunks)
        .check(metadata)
        .commit();

      return result.ok;
    },
    housekeep: async () => {
      const kv = await kvPromise;

      for await (const item of kv.list({ prefix: ["_frsh", "js"] })) {
        if (item.key.includes(BUILD_ID)) continue;

        await kv.delete(item.key);
      }
    },
  };
};

export async function streamToArrayBuffer(
  readableStream: ReadableStream<Uint8Array>
) {
  const reader = readableStream.getReader();
  const chunks = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return new Blob(chunks).arrayBuffer();
}

export async function streamToJson(readableStream: ReadableStream<Uint8Array>) {
  const arrayBuffer = await streamToArrayBuffer(readableStream);
  const textDecoder = new TextDecoder("utf-8");
  const jsonString = textDecoder.decode(arrayBuffer);
  return jsonString ? JSON.parse(jsonString) : null;
}
