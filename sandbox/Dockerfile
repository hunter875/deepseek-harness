# Replace base with an approved digest before building the final verifier image.
ARG NODE_BASE
FROM ${NODE_BASE}
RUN addgroup -g 10001 workload && adduser -D -u 10001 -G workload workload
USER 10001:10001
WORKDIR /candidate
ENTRYPOINT []
CMD ["node", "--version"]
