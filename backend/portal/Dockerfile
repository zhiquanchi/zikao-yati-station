# 押题门户 · 静态网关（Bun 运行时 · 本机交叉构建 linux/amd64 后上传服务器直接运行）
# 构建上下文 = 仓库根：docker build -f backend/portal/Dockerfile .
FROM oven/bun:1-alpine
WORKDIR /app
COPY backend/portal/portal.js backend/portal/subjects.json ./
# 全部科目前端产物由 scripts/stage.js 合成到 build/stage/<prefix>/（单 COPY 收纳任意科目，加科目不改本文件）
COPY build/stage/ /srv/
# 云同步业务逻辑已迁 Go 服务 sync-svc（backend/grade-svc/cmd/syncsvc）：门户仅转发 api/store（上游 SYNC_API，默认 http://sync-svc:8793）
ENV HOST=0.0.0.0 PORT=80
EXPOSE 80
USER bun
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s CMD wget -qO- http://127.0.0.1/__health >/dev/null || exit 1
CMD ["bun", "portal.js"]
