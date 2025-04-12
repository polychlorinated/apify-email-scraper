FROM apify/actor-node-puppeteer-chrome:20
COPY package*.json ./
RUN npm install && npm audit fix --force
COPY . ./