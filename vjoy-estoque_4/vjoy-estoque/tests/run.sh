#!/bin/sh
# sobe um servidor de teste limpo na porta 3100 e roda o e2e
[ -f /tmp/vjoy-test.pid ] && kill $(cat /tmp/vjoy-test.pid) 2>/dev/null; sleep 1
./tests/reset.sh >/dev/null 2>&1
DATABASE_URL=postgres://app:app@localhost/vjoyestoque_test PORT=3100 JWT_SECRET=teste node server/index.js > /tmp/srv.log 2>&1 &
echo $! > /tmp/vjoy-test.pid
sleep 3
BASE=http://localhost:3100 node tests/e2e.js
