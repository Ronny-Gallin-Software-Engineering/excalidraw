FROM node:18 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN yarn --network-timeout 600000

ARG NODE_ENV=production

RUN VITE_APP_WS_SERVER_URL=%SERVER_URL% yarn build:app:docker \
    && find build/assets/ -type f -name index-* -exec sed -i 's/%SERVER_URL%/${APP_WS_SERVER_URL}/g' {} \;

FROM nginx:1.24-alpine

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html
COPY --chmod=777 prepare.sh /prepare.sh

CMD ["/bin/bash", "-c", "/prepare.sh && exec nginx -g 'daemon off;'"]

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
