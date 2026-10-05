FROM nginx:alpine

ARG SERVER_TOKEN
ENV SERVER_TOKEN=${SERVER_TOKEN}

ARG SERVER_IP
ENV SERVER_IP=${SERVER_IP}

COPY app /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# COPY keeps the build host's file modes; nginx workers need world-read access
RUN chmod -R a+rX /usr/share/nginx/html /etc/nginx/conf.d/default.conf

# Copy entrypoint script as /entrypoint.sh
COPY ./entrypoint.sh /docker-entrypoint.d/entrypoint.sh

# Grant Linux permissions and run entrypoint script
RUN chmod +x /docker-entrypoint.d/entrypoint.sh
