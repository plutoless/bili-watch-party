FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o node -g node /data

WORKDIR /app
COPY src ./src
COPY public ./public
COPY package.json ./
USER node
ENV DATA_DIR=/data
ARG RELEASE_SHA
ENV RELEASE_SHA=${RELEASE_SHA}
CMD ["node", "src/server.js"]
