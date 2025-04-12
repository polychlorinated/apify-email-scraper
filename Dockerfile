FROM apify/actor-node-puppeteer-chrome:18

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies with legacy-peer-deps to handle compatibility issues
RUN npm install --legacy-peer-deps

# Copy app source
COPY . ./

# Run in production mode
ENV NODE_ENV=production

# Start the actor
CMD ["npm", "start"]