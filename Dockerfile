# QQ Agents on Linux. The image runs the console in isolated mode, listening
# on 0.0.0.0 inside the container; publish the port to 127.0.0.1 only.
# See docs/DOCKER.md.
FROM node:24-bookworm-slim

# Set to true to bundle Chromium (and CJK fonts) for public-page screenshots.
ARG WITH_CHROMIUM=false
ARG SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates git \
  && if [ "$WITH_CHROMIUM" = "true" ]; then \
    apt-get install -y --no-install-recommends chromium fonts-noto-cjk; \
  fi \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY vendor ./vendor
COPY docs ./docs
COPY scripts/framework-build.mjs ./scripts/framework-build.mjs
COPY README.md LICENSE NOTICE.md UPSTREAM-NOTICE.md ./
RUN if [ -n "$SOURCE_COMMIT" ]; then node scripts/framework-build.mjs --commit "$SOURCE_COMMIT"; fi

# The node image's unprivileged user owns only the data directory.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 3210

# Extra arguments (for example --live) are appended by `docker run` or the
# compose `command:` field.
ENTRYPOINT ["node", "src/updates/supervisor.mjs", "--data", "/data", "--host", "0.0.0.0"]
CMD []
