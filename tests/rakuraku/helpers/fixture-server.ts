import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * フィクスチャの HTML を配る小さなサーバー。
 * 楽楽精算の画面を真似た静的ファイルを返すだけで、外部には一切繋がない。
 *
 * 楽楽精算の「サーバー側で覚える」動きを真似るために、問い合わせ部分を2つだけ解釈する。
 *   ?delay=ミリ秒 … 応答を遅らせる（上限 10 秒）。遅い画面・遅い切り替えの再現
 *   ?bumonCd=値   … 応答と一緒にクッキー dept を覚えさせる（部門の切り替え）。
 *                   ★応答が返る前に別の画面へ移ると、ブラウザは応答を捨てるので**覚えられない**。
 *                   切り替えを待たずに一覧へ進んだときに元の部門のままになる不具合を再現できる。
 */
export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

const dir = fileURLToPath(new URL("../fixtures/", import.meta.url));

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    const name = url.pathname.replace(/^\/+/, "");
    if (!/^[\w.-]+\.html$/.test(name)) {
      res.writeHead(404).end("not found");
      return;
    }
    const delay = Math.min(10_000, Math.max(0, Number(url.searchParams.get("delay")) || 0));
    const dept = url.searchParams.get("bumonCd");
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (dept && /^\d+$/.test(dept)) headers["set-cookie"] = `dept=${dept}; Path=/`;

    setTimeout(() => {
      readFile(`${dir}${name}`)
        .then((body) => {
          if (!res.destroyed) res.writeHead(200, headers).end(body);
        })
        .catch(() => {
          if (!res.destroyed) res.writeHead(404).end("not found");
        });
    }, delay);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
