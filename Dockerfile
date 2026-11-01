FROM alpine:3.20

RUN apk add --no-cache nodejs npm

COPY package.json package-lock.json /app/
RUN cd /app && npm ci --production
COPY server.js simplepdf.js pdffonts.js chargelogpdf.js warp_logo.png /app/
COPY views/ /app/views/

COPY entrypoint.sh /
RUN chmod a+x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
