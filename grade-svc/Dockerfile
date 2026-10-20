# 13180 简答题 AI 判分服务（Go + OpenAI Go SDK · 千问兼容模式）
FROM golang:1.26-alpine AS build
WORKDIR /src
# 国内构建慢/不通时可：docker compose build --build-arg GOPROXY=https://goproxy.cn,direct
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/grade-svc .

FROM alpine:3.21
RUN adduser -D -H -u 10001 svc
WORKDIR /app
COPY --from=build /out/grade-svc ./grade-svc
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# 容器内绑 0.0.0.0：仅 compose 内部网络可达，compose 不映射端口到宿主机（主机直跑默认仍是 127.0.0.1）
ENV GRADE_HOST=0.0.0.0 GRADE_PORT=8792
EXPOSE 8792
USER svc
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s CMD wget -qO- http://127.0.0.1:8792/api/health >/dev/null || exit 1
ENTRYPOINT ["/app/grade-svc"]
