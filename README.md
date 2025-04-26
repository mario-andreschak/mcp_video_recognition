# MCP Video Recognition Server

An MCP (Model Context Protocol) server that provides tools for image, audio, and video recognition using Google's Gemini AI.

## Features

- **Image Recognition**: Analyze and describe images using Google Gemini AI
- **Audio Recognition**: Analyze and transcribe audio using Google Gemini AI
- **Video Recognition**: Analyze and describe videos using Google Gemini AI


## Prerequisites

- Node.js 18 or higher
- Google Gemini API key

## Installation

### Manual Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/mcp-video-recognition.git
   cd mcp-video-recognition
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

### Installing in [FLUJO](https://github.com/mario-andreschak/FLUJO/)

1. Click Add Server
2. Copy & Paste Github URL into FLUJO
3. Click Parse, Clone, Install, Build and Save.

### Installing via Configuration Files

To integrate this MCP server with Cline or other MCP clients via configuration files:

1. Open your Cline settings:
   - In VS Code, go to File -> Preferences -> Settings
   - Search for "Cline MCP Settings"
   - Click "Edit in settings.json"

2. Add the server configuration to the `mcpServers` object:
   ```json
   {
     "mcpServers": {
       "video-recognition": {
         "command": "node",
         "args": [
           "/path/to/mcp-video-recognition/dist/index.js"
         ],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

3. Replace `/path/to/mcp-video-recognition/dist/index.js` with the actual path to the `index.js` file in your project directory. Use forward slashes (/) or double backslashes (\\\\) for the path on Windows.

4. Save the settings file. Cline should automatically connect to the server.

## Configuration

The server is configured using environment variables:

- `GOOGLE_API_KEY` (required): Your Google Gemini API key
- `TRANSPORT_TYPE`: Transport type to use (`stdio` or `sse`, defaults to `stdio`)
- `PORT`: Port number for SSE transport (defaults to 3000)
- `LOG_LEVEL`: Logging level (`verbose`, `debug`, `info`, `warn`, `error`, defaults to `info`)

## Usage

### Starting the Server

#### With stdio Transport (Default)

```bash
GOOGLE_API_KEY=your_api_key npm start
```

#### With SSE Transport

```bash
GOOGLE_API_KEY=your_api_key TRANSPORT_TYPE=sse PORT=3000 npm start
```

### Using the Tools

The server provides three tools that can be called by MCP clients:

#### Image Recognition

```json
{
  "name": "image_recognition",
  "arguments": {
    "filepath": "/path/to/image.jpg",
    "prompt": "Describe this image in detail",
    "modelname": "gemini-2.0-flash"
  }
}
```

#### Audio Recognition

```json
{
  "name": "audio_recognition",
  "arguments": {
    "filepath": "/path/to/audio.mp3",
    "prompt": "Transcribe this audio",
    "modelname": "gemini-2.0-flash"
  }
}
```

#### Video Recognition

```json
{
  "name": "video_recognition",
  "arguments": {
    "filepath": "/path/to/video.mp4",
    "prompt": "Describe what happens in this video",
    "modelname": "gemini-2.0-flash"
  }
}
```

### Tool Parameters

All tools accept the following parameters:

- `filepath` (required): Path to the media file to analyze
- `prompt` (optional): Custom prompt for the recognition (defaults to "Describe this content")
- `modelname` (optional): Gemini model to use for recognition (defaults to "gemini-2.0-flash")

## Development

### Running in Development Mode

```bash
GOOGLE_API_KEY=your_api_key npm run dev
```

### Project Structure

- `src/index.ts`: Entry point
- `src/server.ts`: MCP server implementation
- `src/tools/`: Tool implementations
- `src/services/`: Service implementations (Gemini API)
- `src/types/`: Type definitions
- `src/utils/`: Utility functions

## License

MIT
