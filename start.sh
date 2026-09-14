#!/bin/bash
echo ""
echo "  Bot通用审核系统 - 云端版"
echo "  ========================"
echo ""
export MODERATION_MODE=cloud-only
node src/server.js
