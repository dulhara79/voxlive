FROM node:20-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy deps first for layer caching
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY . .

# Drop root privileges
RUN addgroup -S voxlive && adduser -S -G voxlive voxlive
USER voxlive

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
