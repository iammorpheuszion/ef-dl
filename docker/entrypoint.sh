#!/bin/sh
set -e

# Docker entrypoint script for EF-DL
# Handles initialization and runs the appropriate command

# Ensure downloads directory exists
mkdir -p /app/downloads

# Check if running in interactive mode (no arguments)
if [ $# -eq 0 ]; then
    echo "🚀 Starting EF-DL in interactive mode..."
    echo ""
    exec bun index.ts
else
    # Run with provided arguments
    exec "$@"
fi
