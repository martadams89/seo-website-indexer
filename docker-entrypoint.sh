#!/bin/sh
set -e

# Ensure the data directory exists and is writable by appuser.
# This handles the case where /data is a bind-mount owned by root or another
# user on the host, which would otherwise prevent better-sqlite3 from creating
# the database file.
mkdir -p /data
chown appuser:appgroup /data

exec dumb-init su-exec appuser "$@"
