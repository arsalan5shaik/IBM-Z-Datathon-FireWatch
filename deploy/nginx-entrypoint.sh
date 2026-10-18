#!/bin/sh
# Render the chat route before nginx starts. The root filesystem is read-only, so
# the generated include lives in the /tmp tmpfs. Without CHAT_PROXY_TOKEN, chat
# stays blocked exactly as before; with it, nginx is the trusted gateway that
# overwrites X-FireWatch-Chat-Auth, so browsers can neither see nor forge it.
set -eu
umask 077
conf=/tmp/chat-route.conf
token="${CHAT_PROXY_TOKEN:-}"

if [ -z "$token" ]; then
    echo 'location = /api/v1/chat { return 403; }' > "$conf"
else
    # The backend requires 32+ characters; the charset keeps the value inert in nginx syntax.
    # A case pattern checks every character, newlines included (grep matches per line).
    case "$token" in
        *[!A-Za-z0-9_-]*) token= ;;
    esac
    if [ "${#token}" -lt 32 ]; then
        echo 'CHAT_PROXY_TOKEN must be 32+ characters of [A-Za-z0-9_-] (try: openssl rand -hex 32)' >&2
        exit 1
    fi
    cat > "$conf" <<EOF
location = /api/v1/chat {
    set \$backend http://backend:8000;
    proxy_pass \$backend\$request_uri;
    proxy_set_header Host \$host;
    proxy_set_header X-FireWatch-Chat-Auth "$token";
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Forwarded-Proto "";
    proxy_connect_timeout 5s;
    proxy_read_timeout 120s;
}
EOF
fi

exec nginx "$@"
