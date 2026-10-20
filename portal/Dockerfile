# 押题门户 · 静态网关（Bun 运行时 · 本机交叉构建 linux/amd64 后上传服务器直接运行）
FROM oven/bun:1-alpine
WORKDIR /app
COPY portal.js store.js ./
# 两站前端产物由 deploy.sh 先同步到 build/ 暂存目录（单构建上下文）
COPY build/os/ /srv/os/
COPY build/net/ /srv/net/
ENV HOST=0.0.0.0 PORT=80 STORE_DB=/data/sync.db
EXPOSE 80
USER bun
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s CMD wget -qO- http://127.0.0.1/os/ >/dev/null || exit 1
CMD ["bun", "portal.js"]
