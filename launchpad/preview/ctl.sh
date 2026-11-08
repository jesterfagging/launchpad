#!/usr/bin/env bash
# Preview server control: ./ctl.sh start|stop|restart|status|log
# Env: PORT (4173), MOCK_SESSION (anon|user|admin), LAUNCHPAD_SOURCE, PREVIEW_LOG=all
cd "$(dirname "$0")"
PIDFILE=.server.pid PORT=${PORT:-4173}
running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
case "$1" in
  start)
    if running; then echo "already running (pid $(cat $PIDFILE)) on :$PORT"; exit 0; fi
    nohup node server.mjs > server.log 2>&1 & echo $! > "$PIDFILE"
    for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.1; done
    head -1 server.log ;;
  stop)
    if running; then kill "$(cat $PIDFILE)"; echo "stopped pid $(cat $PIDFILE)"; else echo "not running"; fi; rm -f "$PIDFILE" ;;
  restart) "$0" stop; sleep 0.3; "$0" start ;;
  status) if running; then echo "running (pid $(cat $PIDFILE))"; else echo "stopped"; fi ;;
  log) cat server.log ;;
  *) echo "usage: $0 start|stop|restart|status|log"; exit 2 ;;
esac
