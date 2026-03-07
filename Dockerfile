FROM node:20-alpine

# Install Chromium and dependencies for Puppeteer
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont

# Puppeteer environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for tsx)
RUN npm install

# Copy everything for development
COPY . .

# Start development server
CMD ["npm", "run", "dev"]
