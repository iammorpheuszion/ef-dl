FROM oven/bun:latest AS base

WORKDIR /app

# Install system dependencies required for Puppeteer/Browserless
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    dumb-init \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create a non-root user for security
RUN groupadd -r bunuser && useradd -r -g bunuser -G audio,video bunuser \
    && mkdir -p /home/bunuser/Downloads \
    && chown -R bunuser:bunuser /home/bunuser

# Copy package files first for better caching
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile || bun install

# Copy the rest of the application
COPY . .

# Create downloads directory and set permissions (ensure fonts are accessible)
RUN mkdir -p downloads && chown -R bunuser:bunuser /app && chmod -R 755 /app/fonts

# Switch to non-root user
USER bunuser

# Set environment variables
ENV NODE_ENV=production \
    FORCE_COLOR=1 \
    USE_DEFAULT_DIR=true

# Default command runs the application in interactive mode
# Using dumb-init ensures proper signal handling (Ctrl+C works in Docker)
ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "index.ts"]
