// 前端产物暂存：bun run stage（＝build:web）。
// 只复制一份共享前端到 build/web/；不再按科目复制引擎，也不再读 data.js。
import path from "node:path";
import { mkdirSync, rmSync, cpSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { WEB_DIR, ROOT } from "./config.js";

const FILES = ["index.html", "styles.css", "api.js", "model.js", "app.js", "config.json"];
const dest = path.join(ROOT, "build", "web");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const f of FILES) {
  const src = path.join(WEB_DIR, f);
  if (!existsSync(src)) throw new Error(`缺 frontend/${f}`);
  cpSync(src, path.join(dest, f));
}
chmodSync(dest, 0o755);
for (const ent of readdirSync(dest)) chmodSync(path.join(dest, ent), 0o644);
console.log(`已暂存 build/web/（${FILES.length} 个文件，全部科目共用）`);