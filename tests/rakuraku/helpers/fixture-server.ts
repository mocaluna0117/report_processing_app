import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * フィクスチャの HTML を配る小さなサーバー。
 * 楽楽精算の画面を真似た静的ファイルを返すだけで、外部には一切繋がない。
 */
export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

const dir = fileURLToPath(new URL("../fixtures/", import.meta.url));

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const name = (req.url ?? "/").replace(/^\/+/, "").split("?")[0];
    if (!/^[\w.-]+\.html$/.test(name)) {
      res.writeHead(404).end("not found");
      return;
    }
    readFile(`${dir}${name}`)
      .then((body) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
      })
      .catch(() => {
        res.writeHead(404).end("not found");
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
