FROM node:24-slim

WORKDIR /app

# Instalar curl (necesario para consultar el FDSN de IRIS)
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Copiar package.json e instalar dependencias
COPY package.json ./
RUN npm install --omit=dev

# Copiar el codigo del servidor
COPY . .

EXPOSE 3001

CMD ["node", "--import", "./polyfill.mjs", "index.js"]