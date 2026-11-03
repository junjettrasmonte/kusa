---
title: cao-server must be up for Dev Tools CAO
author: Junjet
date: 2026-11-02
branch: main
touches:
  - src/app/console/dashboard.js
---

## Decided
When the Dev Tools CAO tab looks “not running,” check `cao`/`cao-server` on PATH first, then `GET http://127.0.0.1:9889/health` (default `CAO_BASE_URL`). CLI present + connection refused means start and leave running: `cao-server --host 127.0.0.1 --port 9889`. Kusă only proxies to that server; it does not start it.

## Tried and ruled out
Treating curl timeouts as proof the port is hung: with `HTTP_PROXY` set, curl may send localhost through the proxy and hang. Use `curl --noproxy '*' http://127.0.0.1:9889/health` (or confirm nothing is listening via `ss`/`ss -ltn`) before debugging cao-server itself.

## Watch out
Reload the CAO tab after the server is up. Health OK does not imply every provider CLI is installed — `/agents/providers` reports per-binary availability separately.
