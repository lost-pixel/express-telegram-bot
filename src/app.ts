import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { Telegraf, session, Context } from "telegraf";
import { OpenAIApi, Configuration } from "openai";
import { z } from "zod";
import { config } from "../config";

import { modes } from "./config/modes";

const envSchema = z.object({
  TELEGRAM_TOKEN: z.string().nonempty(),
  OPEN_AI_TOKEN: z.string().nonempty()
});

const COMPLETION_PARAMS = {
  frequency_penalty: 0,
  presence_penalty: 0,
  temperature: 0.6,
  max_tokens: 1000,
  top_p: 1
};

interface SessionData {
  mode?: string;
  chatHistory?: {
    role: "system" | "user" | "assistant";
    content: string;
  }[];
}

interface MyContext extends Context {
  session?: SessionData;
}

const selectedMode = "ASSISTANT";

const env = envSchema.parse(process.env);

const configuration = new Configuration({
  apiKey: env.OPEN_AI_TOKEN
});

const openai = new OpenAIApi(configuration);
const bot = new Telegraf<MyContext>(env.TELEGRAM_TOKEN);

const app = express();

app.use(cors());
app.use(helmet());
app.use(express.json());

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, AUTHORIZATION"
  );
  next();
});

app.get("/ping", (_req: Request, res: Response) => {
  res.send("xx");
});

bot.start((ctx) => {
  ctx.reply(
    "Welcome to the Ed GPT! I'm a bot that can create textual content based on your input. To get started, send me a message with the text you want me to generate content for."
  );
});

bot.use(session());

bot.command("clear", (ctx) => {
  if (ctx.session) {
    ctx.session.chatHistory = undefined;

    const randomStartFromScratchMessages = [
      "Let's start from the scratch! How can I help?",
      "Let's start over! What might I assist you with?",
      "Let's start again! What's on your mind?"
    ];
    const pickRandomMessage =
      randomStartFromScratchMessages[
        Math.floor(Math.random() * randomStartFromScratchMessages.length)
      ];
    ctx.reply(pickRandomMessage);
  }
});

bot.on("text", async (ctx) => {
  if (!ctx.session) {
    ctx.session = {
      mode: selectedMode
    };
  }

  ctx.sendChatAction("typing");

  if (!ctx.session.chatHistory) {
    ctx.session.chatHistory = [
      {
        role: "system",
        content: modes.find((m) => m.code === selectedMode)
          ?.promptStart as string
      },
      { role: "user", content: ctx.message.text }
    ];
  } else {
    ctx.session.chatHistory.push({ role: "user", content: ctx.message.text });
  }

  const completion = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: ctx.session.chatHistory,
    ...COMPLETION_PARAMS
  });

  if (completion.data.choices[0].message) {
    ctx.session.chatHistory?.push(completion.data.choices[0].message);
  }

  ctx.reply(completion.data.choices[0].message?.content as string, {
    parse_mode: modes.find((m) => m.code === selectedMode)?.parseMode as
      | "HTML"
      | "MarkdownV2"
  });
});

bot.launch();

if (!config.isTestEnvironment) {
  app.listen(config.port);
  console.info("App is listening on port:", config.port);
}

export { app };
