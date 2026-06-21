#!/usr/bin/env bash
# Reliable loop step: rebuild web, kill+restart next start against the FRESH build, refresh the
# admin session, then run the full UX audit. Prevents the stale-server "jumbled site" failure.
set -e
cd "$(dirname "$0")/.."   # web/

echo "── rebuild ──"
npm run build > /tmp/wb.log 2>&1 || { echo "BUILD FAILED"; tail -20 /tmp/wb.log; exit 1; }
echo "build ok"

echo "── restart web (kill stale) ──"
lsof -ti:3100 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 2
PORT=3100 KRELVAN_API_ORIGIN=http://localhost:3200 npx next start -p 3100 > /tmp/krelvan-web.log 2>&1 &
until curl -s http://localhost:3100/ >/dev/null 2>&1; do sleep 0.5; done
sleep 1
echo "web up"

echo "── refresh admin session ──"
J=/tmp/audit-cookies.txt; rm -f "$J"
curl -s -c "$J" http://localhost:3100/login >/dev/null 2>&1 || true
curl -s -b "$J" -c "$J" -X POST http://localhost:3100/proxy/api/auth/login \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3100" \
  -d '{"username":"admin","password":"demopass123"}' -o /dev/null -w "login:%{http_code}\n"

echo "── run audit ──"
node audit/ux-audit.mjs
