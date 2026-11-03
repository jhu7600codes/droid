FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY *.mjs ./
ENV PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]
