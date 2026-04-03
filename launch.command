#!/bin/bash
# Double-click this file in Finder to launch BMAD Sprint Overview.
# It opens a Terminal, starts the server, and opens the browser.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=3333

# Kill any existing instance on this port
lsof -ti:$PORT | xargs kill -9 2>/dev/null
sleep 0.5

echo ""
echo "  ◆ BMAD Sprint Overview"
echo "  → Starting server on port $PORT..."
echo "  → Scanning: $(dirname "$DIR")"
echo ""
echo "  Close this window to stop the server."
echo ""

# Start server
cd "$DIR"
node server.js &
SERVER_PID=$!

# Wait for server to be ready
sleep 2

# Open browser
open "http://localhost:$PORT"

# Keep running until window is closed
wait $SERVER_PID
