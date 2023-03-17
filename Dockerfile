# Write a dockerfile for node js app with pnpm

# Use the official node image
FROM node:16

# Set the working directory
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json files
COPY package.json pnpm-lock.yaml ./

# Install pnpm
RUN npm install -g pnpm
RUN npm install -g typescript

# Instal ffmpeg

RUN apt-get update && apt-get install -y ffmpeg

# Install dependencies

RUN pnpm install

# Copy the rest of the app
COPY . .

# Build app
RUN npm run build

# Expose the port
EXPOSE 3000

# Start the app
CMD [ "pnpm", "start" ]
