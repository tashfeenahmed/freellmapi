# 🐋 Docker Setup

This directory contains Docker configuration for the FreeLLMApi application.

## Files

- `Dockerfile` - Multi-stage build Dockerfile for creating the production image
- `../docker-compose.yml` - Docker Compose configuration for local development

## Quick Start

### Using Docker Compose (Recommended)

1. Copy the environment file:
   ```bash
   cp .env.example .env
   ```

2. Generate and add your API key to the newly created .env file using one of these methods:
   - **With Node.js (if installed)**:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 
     ```
   - **With OpenSSL (if installed)**:
     ```bash
     openssl rand -hex 32 
     ```
   - **With Windows (no installation required)**:
     ```bash
     powershell -Command "$bytes = [System.Byte[]]::new(32); [System.Security.Cryptography.RNGCryptoServiceProvider]::Create().GetBytes($bytes); [System.Convert]::ToBase64String($bytes)" 
     ```

3. Build and start the application:
   ```bash
   docker-compose up --build
   ```

4. Run in background:
   ```bash
   docker-compose up -d --build
   ```

5. Stop the application:
   ```bash
   docker-compose down
   ```

**Access the Application**: Once running, open your web browser and navigate to `http://localhost:3001`

### Using Docker Directly

```bash
# Build the image
docker build -f docker/Dockerfile -t freellmapi .

# Run the container
docker run -d \
  --name freellmapi \
  -p 3001:3001 \
  --env-file .env \
  -v ./server/data:/app/server/data \
  -v ./.env:/app/.env:ro \
  --restart unless-stopped \
  freellmapi
```

## Configuration

### Environment Variables

The application requires environment variables defined in `.env` file:

- `NODE_ENV` - Set to "production" for production builds
- `PORT` - Application port (default: 3001)
- Additional variables as defined in `.env.example`

### Data Persistence

The `/app/server/data` directory is mounted as a volume to persist application data between container restarts.

## Build Process

The Dockerfile uses a multi-stage build process:

1. **Build Stage**: Installs all dependencies, builds the application, and prunes dev dependencies
2. **Runtime Stage**: Copies only necessary files and creates a minimal production image

## Ports

- **3001** - Main application port (exposed by default)

## Note: 
If the application requires an API key to function, you can get one for free from [OpenRouter](https://openrouter.ai/keys)