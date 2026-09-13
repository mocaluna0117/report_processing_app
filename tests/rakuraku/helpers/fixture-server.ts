import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * フィクスチャの HTML を配る小さなサーバー。
 * 楽楽精算の画面を真似た静的ファイルを返すだけで、外部には一切繋がない。
 *
 * 楽楽精算の「サーバー側で覚える」動きを真似るために、問い合わせ部分を解釈する。
 *   ?delay=ミリ秒 … 応答を遅らせる（上限 10 秒）。遅い画面・遅い切り替えの再現
 *   ?bumonCd=値   … 応答と一緒にクッキー dept を覚えさせる（部門の切り替え）。
 *                   ★応答が返る前に別の画面へ移ると、ブラウザは応答を捨てるので**覚えられない**。
 *
 * `/files/<名前>` は印刷や添付で受け取るファイル（中身はその場で作る・架空）。
 *   body.pdf    … PDF の形をした小さな中身
 *   photo.png   … PNG の形をした小さな中身（名前を .jpg にして配ると、中身で拡張子を直せるかを確かめられる）
 *   login.pdf   … 中身はログイン画面の HTML（セッションが切れていたときの再現）
 *   preview.html… PDF ではない途中の画面
 *   ?dl=1&fn=名前 … Content-Disposition: attachment で配る（ダウンロードになる）
 *   ?view=1       … 画面として開かれたら HTML、裏で取得されたら PDF を返す（ブラウザ内の PDF 表示の再現）
 */
export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

const dir = fileURLToPath(new URL("../fixtures/", import.meta.url));

export const SAMPLE_PDF = new TextEncoder().encode("%PDF-1.4\n% 架空の本体PDF（テスト用）\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
export const SAMPLE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const LOGIN_HTML = new TextEncoder().encode(
  '<!doctype html><html><body><form><input type="text" name="loginId"><input type="password" name="password"></form></body></html>',
);
const PREVIEW_HTML = new TextEncoder().encode("<!doctype html><html><body>印刷の準備をしています</body></html>");

const FILES: Record<string, { bytes: Uint8Array; type: string }> = {
  "body.pdf": { bytes: SAMPLE_PDF, type: "application/pdf" },
  "photo.png": { bytes: SAMPLE_PNG, type: "image/png" },
  "login.pdf": { bytes: LOGIN_HTML, type: "text/html; charset=utf-8" },
  "preview.html": { bytes: PREVIEW_HTML, type: "text/html; charset=utf-8" },
};

function serveFile(req: IncomingMessage, res: ServerResponse, name: string, url: URL): void {
  const file = FILES[name];
  if (!file) {
    res.writeHead(404).end("not found");
    return;
  }
  const headers: Record<string, string> = { "content-type": file.type };
  if (url.searchParams.get("dl") === "1") {
    const fn = (url.searchParams.get("fn") ?? name).replace(/[^\w.-]/g, "_");
    headers["content-disposition"] = `attachment; filename="${fn}"`;
  }
  if (url.searchParams.get("view") === "1" && req.headers["sec-fetch-mode"] === "navigate") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>PDF</title><body>PDFを表示しています</body>");
    return;
  }
  res.writeHead(200, headers).end(file.bytes);
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    const name = url.pathname.replace(/^\/+/, "");
    const delay = Math.min(10_000, Math.max(0, Number(url.searchParams.get("delay")) || 0));

    const fileMatch = /^files\/([\w.-]+)$/.exec(name);
    if (fileMatch) {
      setTimeout(() => {
        if (!res.destroyed) serveFile(req, res, fileMatch[1], url);
      }, delay);
      return;
    }
    if (!/^[\w.-]+\.html$/.test(name)) {
      res.writeHead(404).end("not found");
      return;
    }
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
