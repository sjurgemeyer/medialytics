#!/bin/sh
set -e

# Bind-mounted data directories are often created by Docker as root; hand them to the
# unprivileged node user, then run the server as that user.
if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_DIR"
    find "$DATA_DIR" ! -user node -exec chown node:node {} +
    exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
