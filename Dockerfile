FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
