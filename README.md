# Dashcam CLI Minimal

A minimal command-line interface version of the Dashcam desktop application, focusing on core functionality:
- Screen recording using FFmpeg
- Authentication via Auth0
- Log tracking
- Automatic upload of recordings

## Prerequisites

- Node.js 14 or higher
- FFmpeg (included via ffmpeg-static)

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file with the following variables:

```
AUTH0_DOMAIN=your_auth0_domain
AUTH0_CLIENT_ID=your_auth0_client_id
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=your_aws_region
```

## Usage

### Authentication

```bash
dashcam login
```

### Start Recording

```bash
# Record indefinitely
dashcam record

# Record for a specific duration (in seconds)
dashcam record --duration 60
```

### Stop Recording

```bash
dashcam stop
```

## Development

The project structure is organized as follows:

- `/bin` - CLI entry point
- `/lib` - Core functionality modules
- `/src` - Source code

## Building Standalone Executables

**Note:** This project uses ES modules (`"type": "module"`), which have limited support in `pkg`. The recommended distribution method is via npm or using a Node.js version manager.

However, if you need standalone executables, here are the available options:

### Option 1: NPM Global Install (Recommended)

```bash
npm install -g .
```

Users can then run `dashcam` from anywhere on their system.

### Option 2: Using pkg (Experimental)

This project includes `pkg` configuration, but due to ES module limitations, the executables may not work correctly. If you want to try:

```bash
# Install dependencies
npm install

# Build for all platforms
npm run build:all

# Or build for specific platforms
npm run build:macos   # macOS (x64 and ARM64)
npm run build:linux   # Linux (x64 and ARM64)
npm run build:windows # Windows (x64)
```

**Known Limitations:**
- ES module features (`import.meta`, top-level await) have limited `pkg` support
- Some dependencies may not bundle correctly
- Executables may be larger than expected due to including source files

### Option 3: Docker Distribution

Create a Docker container for cross-platform distribution:

```dockerfile
FROM node:18-slim
WORKDIR /app
COPY . .
RUN npm install --production
ENTRYPOINT ["node", "bin/dashcam.js"]
```

Build and run:
```bash
docker build -t dashcam-cli .
docker run -it dashcam-cli --help
```

## License

MIT
