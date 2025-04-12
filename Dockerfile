FROM apify/actor-node-puppeteer-chrome:18

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Create the node_modules directory and give it proper permissions
RUN mkdir -p /usr/src/app/node_modules && \
    chmod -R 777 /usr/src/app/node_modules

# Install dependencies with legacy-peer-deps to handle compatibility issues
RUN npm install --legacy-peer-deps --no-optional

# Copy app source
COPY . ./

# Run in production mode
ENV NODE_ENV=production

# Start the actor
CMD ["npm", "start"]