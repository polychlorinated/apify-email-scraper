FROM apify/actor-node-puppeteer-chrome:18

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies with legacy-peer-deps to handle compatibility issues
# Add retry for network reliability
RUN npm install --legacy-peer-deps --no-optional --network-timeout=100000 || \
    npm install --legacy-peer-deps --no-optional --network-timeout=100000 || \
    npm install --legacy-peer-deps --no-optional --network-timeout=100000

# Copy app source
COPY . ./

# Run in production mode
ENV NODE_ENV=production

# Start the actor
CMD ["npm", "start"]