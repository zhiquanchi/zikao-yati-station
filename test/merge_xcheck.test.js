// 云同步合并口径 golden 断言（JS 侧守卫）：多用户改造后合并逻辑跨语言两份实现——
// 前端 web/sync.js（本测试断言）与 Go 云同步服务 grade-svc/cmd/syncsvc（store_golden_test.go 断言），
// 两边共同对齐唯一夹具 test/fixtures/merge_golden.json（scripts/gen-merge-golden.js 生成）——
// 改任何一处合并口径而夹具未同步刷新，对应一侧必红（跨语言「两处实现、一处守卫」）。
// 另由载荷契约段锁定：前端 payloadStore/payloadShuf 的真实产物必过 Go 端 normalizeIncoming 且形状原样不改
// （本测试断言「重放输入 == 夹具产物」防前端载荷生成漂移；「产物过 Go 校验」由 Go 侧 golden 断言）。
import { describe, it, expect } from "bun:test";
import "../web/sync.js";

const front = globalThis.SYNC;
const golden = await Bun.file(new URL("./fixtures/merge_golden.json", import.meta.url)).json();
const NOW = golden.now;

describe("sync.mergeBlobs ≡ golden 夹具", () => {
  it(`${golden.merges.length} 组随机/退化夹具逐字段命中`, () => {
    for (let i = 0; i < golden.merges.length; i++) {
      const c = golden.merges[i];
      expect(front.mergeBlobs(c.a, c.b, NOW), "第 " + i + " 组").toEqual(c.out);
    }
  });
});

describe("前端上传载荷 ≡ golden 夹具（契约防漂移）", () => {
  it("payloadStore/payloadShuf 按夹具输入重放逐字段一致", () => {
    for (let i = 0; i < golden.payloads.length; i++) {
      const c = golden.payloads[i];
      expect(front.payloadStore(c.cur, c.snap, c.skip, NOW), "第 " + i + " 组 store").toEqual(c.payload);
      expect(front.payloadShuf(c.shufIn, c.snapShufIn, NOW), "第 " + i + " 组 shuf").toEqual(c.shufOut);
    }
  });
});
