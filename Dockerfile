FROM node:24-slim

WORKDIR /app

# Instalar curl y certificados SSL (necesario para consultar Earthscope/IRIS via HTTPS)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/requirements-magnitude.txt /app/scripts/requirements-magnitude.txt
RUN python3 -m venv /opt/magnitude && /opt/magnitude/bin/pip install --no-cache-dir -r /app/scripts/requirements-magnitude.txt
ENV MAGNITUDE_PYTHON=/opt/magnitude/bin/python

# Copiar package.json e instalar dependencias
COPY package.json ./
RUN npm install --omit=dev

# Copiar el codigo del servidor (incluye services/, polyfill.mjs, stations.txt)
COPY . .

EXPOSE 3001

CMD ["node", "--import", "./polyfill.mjs", "index.js"]
