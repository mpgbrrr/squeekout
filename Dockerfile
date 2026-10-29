# The watcher service: watches Squeekchain's live feed, posts game decisions, and serves the web app.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY watcher ./watcher
COPY web ./web
COPY deployments ./deployments
ENV NODE_ENV=production PORT=3000 STATE_FILE=/data/state.json
EXPOSE 3000
CMD ["node", "watcher/watcher.mjs"]
