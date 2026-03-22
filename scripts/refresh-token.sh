#!/bin/bash
# Refresh Claude Max OAuth token on server
# Usage: ./scripts/refresh-token.sh [local_user@local_ip]
#
# Option 1: Run `claude auth login` directly on server
# Option 2: Copy token from local machine

set -e

echo "=== Claude Token Refresh ==="

if command -v claude &> /dev/null; then
  echo "Attempting claude auth refresh..."
  claude auth login
  echo "✅ Token refreshed via claude auth"
else
  echo "claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

echo ""
echo "Restart the service:"
echo "  pm2 restart openclaw"
