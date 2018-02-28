FROM resin/raspberrypi3-node:slim

WORKDIR /opt/node-nest

COPY package.json .

CMD ["npm", "install"]

COPY . .

CMD ["npm", "start"]
