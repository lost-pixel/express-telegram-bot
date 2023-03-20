<div align='center'><img width='150px' height='150px' src='https://user-images.githubusercontent.com/29632358/226184235-941e2b0e-3404-4058-9eb1-ecc296c15a32.png'>
</div>
<div align="center">
  <h1><a href="https://ed-gpt.carrd.co">Ed-GPT</a></h1>
  <h2>Powerful telegram client for Telegram </h2>  
  <h3 align="center"> Proudly built in <b>Asutria 🇦🇹 & Ukraine 🇺🇦</b> by <b><a href="https://github.com/lost-pixel/lost-pixel"> Lost Pixel team  </a></b> </h3>
  
  <a href="https://github.com/lost-pixel/lost-pixel/blob/main/docs/contributing.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" /></a>
  <a href="https://github.com/lost-pixel/lost-pixel/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lost-pixel/lost-pixel" /></a>
  <a href="https://discord.gg/WqVjk49g9m"><img src="https://img.shields.io/badge/chat-discord-blue?style=flat&logo=discord" alt="discord chat"></a>
  <a href="https://twitter.com/lostpixel_app"><img src="https://img.shields.io/twitter/follow/lostpixel_app?style=social" alt="twitter profile"></a>
  <br />

</div>


  <hr />

## What is Ed-Gpt ❓

Ed-GPT is a powerful Telegram client that offers advanced features and customization options to enhance your Telegram messaging experience. Built on the GPT-3.5 language model, Ed-GPT offers advanced AI-powered features such as text completion, automatic summarization, and translation capabilities. You can use the serviced version of the bot by providing you Open AI token or self-host it yourself.

## Motivation

We are big fans of ChatGpt & Telegram so we decided to combine them in one single tool, there are also lots of Python ChatGpt bots but not many good examples of ones built in `Node.js` ecosystem with `TypeScript`. All of it written in **350 lines of code**.


## Features
- Blazing fast replies ⚡
- No limits with your own token 🚀
- Voice message recognition 🗣️
- Modes: Assistant 🧑🏼‍💻, Stand-up Comedian 🎤, Conservatory Teacher 🎶, Principal Software Engineer 💻 (Add your own or request new modes by creating new Issue)

## Bot commands

- `/clear` – Clears the current chat and starts from the scratch
- `/mode` – Select mode of the AI companion
- `/settings` – Choose additional settings for prompting
- `/token` – Add your Open AI token

## Running Ed-Gpt

You can use the bot deployed by us or self-host it at your convenience.

### Setup (Managed)
1. Get [OpenAI API](https://openai.com/api/) key
2. Run `/token sk-xxxx-xxxx-xxxx` (with your token) to add it to the telegram

### Setup (Self-hosted)

1. Build Docker image
2. Create a postgres database for session storage (persistence of bot settings between bot redeployments and crashes)
3. Provide all necessary env vars
4. Deploy the project on the platform of choice via running Docker image

## Contributing 
1. Get [OpenAI API](https://openai.com/api/) key
2. Run `/token sk-xxxx-xxxx-xxxx` (with your token) to add it to the telegram
3. Create a development bot via Botfather. Get the token from Botfather and add it as `TELEGRAM_TOKEN=YOUR_TOKEN_GOES_HERE`
4. Run `docker compose up -d` to get the database up and running
5. Run `npm run start:dev` to run express server
6. Create a PR with the contribution and let us review it :D 
