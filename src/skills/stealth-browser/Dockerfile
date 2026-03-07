FROM node:22-bullseye-slim

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chrome that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] https://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 libnss3 dbus dbus-x11 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ensure standard output is unbuffered
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

COPY package.json ./
RUN npm install

COPY server.js ./

# Add user so we don't need --no-sandbox.
RUN groupadd -r pptruser && useradd -rm -g pptruser -G audio,video pptruser
RUN chown -R pptruser:pptruser /app

USER pptruser

# The MCP server communicates over standard stdio
CMD ["node", "server.js"]
