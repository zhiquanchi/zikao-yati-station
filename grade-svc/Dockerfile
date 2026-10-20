# 自考简答 AI 判分服务（Go + OpenAI Go SDK · 千问兼容模式）——多科目共用同一份源码。
# 构建上下文 = 仓库根：docker build -f grade-svc/Dockerfile --build-arg SUBJECT=os13180 .
# SUBJECT 指定科目目录名；subject.json 与参考资料（科目 grade/reference.md，可选）暂存进镜像 /app/subject/，
# 运行时 SUBJECT_DIR 读取——判分 prompt 与逐项解析资料的科目身份都来自科目目录，不在本镜像源码里写死。
FROM golang:1.26-alpine AS build
WORKDIR /src
# 国内构建慢/不通时可：docker build --build-arg GOPROXY=https://goproxy.cn,direct
COPY grade-svc/go.mod grade-svc/go.sum ./
RUN go mod download
COPY grade-svc/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/grade-svc .

# 科目配置暂存：独立层，科目数据变化不重编二进制
FROM alpine:3.21 AS subject-stage
COPY subjects/ /contexts/
ARG SUBJECT=os13180
RUN mkdir -p /subject \
 && cp /contexts/${SUBJECT}/subject.json /subject/subject.json \
 && if [ -f /contexts/${SUBJECT}/grade/reference.md ]; then cp /contexts/${SUBJECT}/grade/reference.md /subject/reference.md; fi

FROM alpine:3.21
RUN adduser -D -H -u 10001 svc
WORKDIR /app
COPY --from=build /out/grade-svc ./grade-svc
COPY --from=subject-stage /subject /app/subject
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# 容器内绑 0.0.0.0：仅 compose 内部网络可达，compose 不映射端口到宿主机（主机直跑默认仍是 127.0.0.1）
ENV GRADE_HOST=0.0.0.0 GRADE_PORT=8792 SUBJECT_DIR=/app/subject
EXPOSE 8792
USER svc
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s CMD wget -qO- http://127.0.0.1:8792/api/health >/dev/null || exit 1
ENTRYPOINT ["/app/grade-svc"]
