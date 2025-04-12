FROM apify/actor-node-puppeteer-chrome:18

# Copy package.json and package-lock.json first for better caching
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . ./

# Set the default command to run the actor
CMD ["npm", "start"]