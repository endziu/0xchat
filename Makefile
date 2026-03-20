.PHONY: start stop restart clear

PID_FILE := .server.pid

start:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Server already running (PID $$(cat $(PID_FILE)))"; \
	else \
		nohup bun run server.ts > /dev/null 2>&1 & \
		echo $$! > $(PID_FILE); \
		echo "Server started (PID $$(cat $(PID_FILE)))"; \
	fi

stop:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		kill $$(cat $(PID_FILE)) && rm -f $(PID_FILE); \
		echo "Server stopped"; \
	else \
		rm -f $(PID_FILE); \
		echo "Server not running"; \
	fi

restart: stop clear
	bun run build
	nohup bun run server.ts > /dev/null 2>&1 & \
	echo $$! > $(PID_FILE); \
	echo "Server started (PID $$(cat $(PID_FILE)))"

clear:
	rm -f chat.db chat.db-shm chat.db-wal
	@echo "DB cleared"
