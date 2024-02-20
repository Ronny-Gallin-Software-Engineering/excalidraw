FROM node:20 AS build

WORKDIR /opt/node_app

COPY package.json yarn.lock ./
RUN yarn --ignore-optional --network-timeout 600000

ARG NODE_ENV=production

COPY . .

RUN VITE_APP_WS_SERVER_URL=%SERVER_URL% yarn build:app:docker \
    && ls -la \
    && find build/assets/ -type f -name index-* -exec sed -i 's/%SERVER_URL%/${APP_WS_SERVER_URL}/g' {} \;

FROM nginxinc/nginx-unprivileged:1.25

COPY --from=build --chmod=766 --chown=101 /opt/node_app/build /usr/share/nginx/html
COPY --chmod=777 prepare.sh /prepare.sh

CMD ["/bin/bash", "-c", "/prepare.sh && exec nginx -g 'daemon off;'"]

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
