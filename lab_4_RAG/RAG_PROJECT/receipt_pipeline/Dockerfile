# Use official Node.js LTS image
FROM node:18

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose the app port (adjust if needed)
EXPOSE 3000

# Start the app (adjust if your entry point is different)
CMD ["node", "index.js"]
