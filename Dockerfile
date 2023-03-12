# Write a dockerfile for node js app with pnpm

# Use the official node image
FROM node:16

# Set the working directory
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json files
COPY package.json pnpm-lock.yaml ./

# Install pnpm
RUN npm install -g pnpm

# Build app
RUN pnpm build

# Install dependencies

RUN pnpm install

# Copy the rest of the app
COPY . .

# Expose the port
EXPOSE 3000

# Start the app
CMD [ "pnpm", "start" ]
