// 同じネットワークの別端末から Folio の開発サーバーを開くための起動役。
// 会社のPCなど、手元とは別の端末で画面を確かめたいときに使う。
//
//   npm run dev:lan            … このPCのLANアドレスを自動で選ぶ
//   npm run dev:lan -- --host 192.168.1.23   … 手で指定する
//   npm run dev:lan -- --print               … 開くURLと登録するURIを出すだけ
//
// ★ HTTPS で起動する。File System Access API など一部の機能は
//   localhost 以外では HTTPS でないと使えないため。
//   証明書は next が mkcert で作る (certificates/ に入る。git 管理外)。
//   -H に渡したアドレスが証明書に入るので、必ず LANのアドレスを渡すこと。
import { spawn } from "node:child_process";
import { homedir, networkInterfaces, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 私的アドレスを優先して1つ選ぶ (Wi-Fi と有線の両方があるPCでも迷わないように) */
function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      const a = net.address;
      const priv =
        a.startsWith("192.168.") ||
        a.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(a);
      found.push({ name, address: a, priv });
    }
  }
  found.sort((x, y) => Number(y.priv) - Number(x.priv));
  return found;
}

/** mkcert が自分の認証局を置く場所 (別端末に入れる rootCA.pem のありか) */
function caRoot() {
  if (process.env.CAROOT) return process.env.CAROOT;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "mkcert");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? homedir(), "mkcert");
  return join(homedir(), ".local", "share", "mkcert");
}

const argv = process.argv.slice(2).filter((a) => a !== "--print");
const printOnly = process.argv.includes("--print");
const hostIndex = argv.indexOf("--host");
const explicit = hostIndex >= 0 ? argv[hostIndex + 1] : process.env.LAN_HOST;
const rest = hostIndex >= 0 ? [...argv.slice(0, hostIndex), ...argv.slice(hostIndex + 2)] : argv;

const found = lanAddresses();
const host = explicit ?? found[0]?.address;
if (!host) {
  console.error("LANのアドレスが見つかりませんでした。Wi-Fi か有線に繋いでから、もう一度実行してください。");
  console.error("手で指定するには: npm run dev:lan -- --host 192.168.1.23");
  process.exit(1);
}

// 3000 は他のプロジェクトと取り合いになりやすいので、Folio は 3502 を使う
const port = process.env.PORT ?? "3502";
const origin = `https://${host}:${port}`;
const line = "─".repeat(64);
console.log(`\n${line}`);
console.log(`  別の端末のブラウザで開く : ${origin}`);
if (found.length > 1) {
  console.log(`  ほかの候補               : ${found.slice(1).map((f) => `${f.address} (${f.name})`).join(", ")}`);
}
console.log(`${line}`);
console.log("  ★ 証明書はこのPCが自分で作ったものなので、別の端末では");
console.log("     「この接続ではプライバシーが保護されません」と出ます。");
console.log("     「詳細設定」→「アクセスする」で進めば使えます。");
console.log("     警告を出したくないときは、次のファイルを別端末に入れて");
console.log("     「信頼されたルート証明機関」に取り込みます:");
console.log(`       ${join(caRoot(), "rootCA.pem")}`);
console.log(`${line}`);
console.log(`  ★ このPCからは https://localhost:${port} では開けません（上のアドレスを使ってください）`);
console.log("  ★ アドレスは繋ぎ直すと変わることがあります（この表示で確かめてください）。");
console.log(`${line}\n`);

// 呼び出し側が -p / --port を書いていればそちらを優先する
const portArgs = rest.some((a) => a === "-p" || a === "--port") ? [] : ["-p", port];

if (printOnly) process.exit(0);

// ★ 初回は mkcert を取ってきて、このPCに認証局を入れる。
//   その途中で macOS / Windows がパスワードを聞いてくるので、そのまま入力すること。
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const child = spawn(
  process.execPath,
  [nextBin, "dev", "--experimental-https", "-H", host, ...portArgs, ...rest],
  { stdio: "inherit", env: process.env },
);
child.on("exit", (code) => process.exit(code ?? 0));
