FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./

#production зависимости
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD [ "npm", "start" ]