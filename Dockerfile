# Imagen única para la PC del consultorio o un servidor: build + migraciones al arrancar.
FROM node:22-alpine
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
# Aplica migraciones pendientes (idempotente) y levanta la app.
CMD ["sh", "-c", "npm run db:migrate && npm start -- -p 3000"]
