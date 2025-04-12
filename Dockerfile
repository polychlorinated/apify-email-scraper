FROM apify/actor-node-puppeteer-chrome:18

# Copy package.json files
COPY package*.json ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy the rest of application source code
COPY . ./

# Start the actor
CMD ["npm", "start"]