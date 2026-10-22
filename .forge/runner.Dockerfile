# Claude Lens's runner image. Forge builds it with this file alone as its context, behind its
# egress proxy, and mounts its agent harness read-only at /opt/forge-sdk at run time, so the
# image carries this repository's stack only: Node 22, git and pnpm through corepack.
# The full bookworm image already holds git and ca-certificates, so no step installs a package.
FROM node:22-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384

LABEL com.forge.harness=mounted

# HOME is an empty tmpfs at run time, so corepack keeps pnpm outside it, readable by every user.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_DEFAULT_TO_LATEST=0

RUN useradd --uid 1001 --user-group --create-home --shell /bin/bash runner \
 && mkdir -p /work /pnpm-store /opt/corepack \
 && chown runner:runner /work /pnpm-store /opt/corepack \
 && corepack enable pnpm

USER runner
WORKDIR /

# pnpm 10.29.3 is package.json's "packageManager"; corepack reads the proxy only with NODE_USE_ENV_PROXY.
RUN NODE_USE_ENV_PROXY=1 corepack prepare pnpm@10.29.3 --activate

RUN fail=0; \
    out="$(id -u 2>&1)"; [ "$out" = 1001 ] || { echo "id -u printed: $out" >&2; fail=1; }; \
    out="$(git --version 2>&1)" || { echo "git --version failed: $out" >&2; fail=1; }; \
    out="$(node --version 2>&1)"; case "$out" in v22.*) ;; *) echo "node --version printed: $out" >&2; fail=1 ;; esac; \
    out="$(pnpm --version 2>&1)"; [ "$out" = 10.29.3 ] || { echo "pnpm --version printed: $out" >&2; fail=1; }; \
    exit "$fail"
