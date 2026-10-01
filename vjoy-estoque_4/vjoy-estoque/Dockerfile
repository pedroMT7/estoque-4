FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --include=dev
COPY . .
RUN cd web && npx vite build && rm -rf node_modules
EXPOSE 3000
CMD ["node", "server/index.js"]
