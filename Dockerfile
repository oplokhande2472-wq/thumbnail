FROM node:22-slim
# Image engine (OpenAI's official CLI; it signs in with each teammate's ChatGPT account)
RUN npm install -g @openai/codex && npm cache clean --force
WORKDIR /app
COPY . .
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server.js"]
