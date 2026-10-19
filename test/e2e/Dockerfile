# Mimics the Claude Code cloud sandbox: Ubuntu 24.04, Node 22, root, egress through a proxy.
FROM ubuntu:24.04

ARG NODE_VERSION=22.12.0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3-pip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Node 22 from the official tarball, the version the cloud image ships.
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1

# Everything after the build goes through the proxy; apt and git honor the lowercase names.
ENV HTTPS_PROXY=http://squid:3128 \
    HTTP_PROXY=http://squid:3128 \
    https_proxy=http://squid:3128 \
    http_proxy=http://squid:3128 \
    NO_PROXY=localhost,127.0.0.1 \
    no_proxy=localhost,127.0.0.1

WORKDIR /work
CMD ["sleep", "infinity"]
