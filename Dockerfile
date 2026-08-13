FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm install --no-save typescript@^5.5.0 && \
    npm run build && \
    npm prune --omit=dev
EXPOSE 3000
CMD ["node", "dist/cli.js", "serve"]