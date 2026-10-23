# UNTESTED: written without a Docker daemon available. Verify with `docker build` before relying on it.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm install --no-save tsx
ENV NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx","tsx","packages/bot/src/main.ts"]
