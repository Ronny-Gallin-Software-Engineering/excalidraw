#!/bin/sh

find /usr/share/nginx/html/assets -type f -name 'index*' -exec sh -c "envsubst '\$APP_WS_SERVER_URL' < {} > {}.tmp && mv {}.tmp {}" \;
