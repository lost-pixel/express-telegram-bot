import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { OpenAIApi, Configuration } from "openai";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import * as Tracing from "@sentry/tracing";

import { modes } from "./config/modes";

import path from "path";
import os from "os";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";

import { Bot, Context, session, SessionFlavor } from "grammy";
import { PsqlAdapter } from "@grammyjs/storage-psql";
import { FileFlavor, hydrateFiles } from "@grammyjs/files";
import { Client } from "pg";

import * as dotenv from "dotenv"; // see https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import

dotenv.config();

const COMPLETION_PARAMS = {
  frequency_penalty: 0,
  presence_penalty: 0,
  temperature: 0.6,
  max_tokens: 1000,
  top_p: 1
};

type ChatHistoryItem = {
  role: "system" | "user" | "assistant";
  content: string;
};

type SessionData = {
  mode?: string;
  token?: string;
  messagesCount: number;
  chatHistory?: ChatHistoryItem[];
  settings?: {
    [key: string]: boolean;
  };
};

type MyContext = FileFlavor<Context> & SessionFlavor<SessionData>;

const envSchema = z.object({
  TELEGRAM_TOKEN: z.string().nonempty(),
  OPEN_AI_PLATFORM_TOKEN: z.string().nonempty(),
  NO_OAI_TOKEN_MESSAGE_LIMIT: z.string().nonempty(),
  PG_HOST: z.string().nonempty(),
  PG_USER: z.string().nonempty(),
  PG_PASSWORD: z.string().nonempty(),
  PG_PORT: z.string().nonempty(),
  PG_DB: z.string().nonempty(),
  WEBHOOK_DOMAIN: z.string().nonempty(),
  WEBHOOK_PORT: z.string().nonempty()
});
const env = envSchema.parse(process.env);

const selectedMode = "ASSISTANT";

const app = express();

app.use(cors());
app.use(helmet());
app.use(express.json());

Sentry.init({
  dsn: "https://a80e3c83fef543c09d1a2fbd8d86462b@o1213710.ingest.sentry.io/4504854484615168",
  integrations: [
    new Sentry.Integrations.Http({ tracing: true }),
    new Tracing.Integrations.Express({ app })
  ],
  tracesSampleRate: 0.1
});

app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, AUTHORIZATION"
  );
  next();
});

async function bootstrap() {
  const client = new Client({
    user: env.PG_USER,
    host: env.PG_HOST,
    database: env.PG_DB,
    password: env.PG_PASSWORD,
    port: Number(env.PG_PORT)
  });

  await client.connect();

  const bot = new Bot<MyContext>(env.TELEGRAM_TOKEN);

  // Use file plugin to make working with voice messages easier

  bot.api.config.use(hydrateFiles(bot.token));

  bot.use(
    session({
      storage: await PsqlAdapter.create({ tableName: "sessions", client })
    })
  );

  bot.command("start", (ctx) => {
    ctx.reply(
      `Hey, I'm <b>Ed GPT</b>! I'm a bot that can create textual content based on your input based on ChatGPT model. To get started, send me a message with the text you want me to generate content for. You can try it out for <b>${env.NO_OAI_TOKEN_MESSAGE_LIMIT}</b>  messages without an <b>OpenAI API token</b>.\n\nAfter that, you'll need to provide a token to continue using the bot.\n\nYou can easily get a token for free at https://platform.openai.com/account/api-keys`,
      {
        parse_mode: "HTML"
      }
    );
  });

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

  bot.command("token", (ctx) => {
    try {
      const tokenFromArg = ctx.message?.text.split(" ")[1];

      const tokenSchema = z.string().nonempty().min(5);

      const token = tokenSchema.parse(tokenFromArg);

      if (ctx.session) {
        ctx.session.token = token;
      }

      ctx.reply(
        `Your token has been set. You can now use the bot without any limitations. Unlock premium feature of Ed GPT.`
      );
    } catch (error) {
      ctx.reply(
        `Please provide a valid token. You can easily get a token for free at https://platform.openai.com/account/api-keys`
      );
      return;
    }
  });

  bot.on("message:text", handleMessage);

  bot.on("message:voice", handleVoiceMessage);

  bot.start();
}

bootstrap();

const shouldWarnAboutToken = (ctx: MyContext) =>
  ctx.session &&
  ctx.session.messagesCount >= Number(env.NO_OAI_TOKEN_MESSAGE_LIMIT) &&
  !ctx.session.token;

const warnAboutTokenLimit = (ctx: MyContext) =>
  ctx.reply(
    `You have reached the limit of ${env.NO_OAI_TOKEN_MESSAGE_LIMIT} messages without an OpenAI API token. You can easily get a token for free at https://platform.openai.com/account/api-keys`
  );

const getChatHistory = (ctx: MyContext, content: string): ChatHistoryItem[] => {
  if (!ctx.session.chatHistory) {
    ctx.session.chatHistory = [
      {
        role: "system",
        content: modes.find((m) => m.code === selectedMode)
          ?.promptStart as string
      },
      { role: "user", content }
    ];
    return ctx.session.chatHistory;
  } else {
    ctx.session.chatHistory.push({
      role: "user",
      content
    });
    return ctx.session.chatHistory;
  }
};

const getChatCompletion = async (ctx: MyContext, prompt: string) => {
  const configuration = new Configuration({
    apiKey: ctx?.session?.token ?? env.OPEN_AI_PLATFORM_TOKEN
  });

  const openai = new OpenAIApi(configuration);

  await ctx.replyWithChatAction("typing");

  const chatHistory = getChatHistory(ctx, prompt);

  const completion = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: chatHistory,
    ...COMPLETION_PARAMS
  });

  ctx.session.messagesCount = ctx.session.messagesCount + 1;

  if (completion.data.choices[0].message) {
    ctx.session.chatHistory?.push(completion.data.choices[0].message);
  }

  return completion.data.choices[0].message;
};

const getPrompt = (ctx: MyContext) => {
  const prompt = `${ctx.message?.text}. ${
    ctx.session?.settings?.skipProse ? "Skip prose." : ""
  }`;

  return prompt;
};

const replyWithChatCompletion = async (ctx: MyContext, completion: string) => {
  await ctx.replyWithChatAction("typing");
  await ctx.reply(completion, {
    parse_mode: modes.find((m) => m.code === selectedMode)?.parseMode as
      | "HTML"
      | "MarkdownV2"
  });
};

const handleMessage = async (ctx: MyContext) => {
  const prompt = getPrompt(ctx);

  if (shouldWarnAboutToken(ctx)) {
    warnAboutTokenLimit(ctx);
    return;
  }

  try {
    const completion = await getChatCompletion(ctx, prompt);
    if (!completion) return ctx.reply("Error getting completion from ChatGPT");
    replyWithChatCompletion(ctx, completion.content);
  } catch (error) {
    console.log(error);
  }
};

const handleVoiceMessage = async (ctx: MyContext) => {
  ctx.reply("🔊 Processing your voice message...");

  if (shouldWarnAboutToken(ctx)) {
    warnAboutTokenLimit(ctx);
    return;
  }

  const file = await ctx.getFile(); // valid for at least 1 hour
  const downloadedFilePath = await file.download();

  try {
    ffmpeg(downloadedFilePath)
      .toFormat("mp3")
      .on("error", function (err) {
        console.log(
          "An error occurred while converting with mmpeg: " + err.message
        );
      })
      .on("end", async function () {
        console.log("Processing finished !");

        const configuration = new Configuration({
          apiKey: ctx?.session?.token ?? env.OPEN_AI_PLATFORM_TOKEN
        });

        const openai = new OpenAIApi(configuration);

        const transcript = await openai.createTranscription(
          fs.createReadStream(
            path.join(os.tmpdir(), `${ctx.message?.voice?.file_id}.mp3`)
          ) as any,
          "whisper-1"
        );

        try {
          const completion = await getChatCompletion(ctx, transcript.data.text);

          if (!completion)
            return ctx.reply("Error getting completion from ChatGPT");

          replyWithChatCompletion(ctx, completion?.content);
        } catch (error) {
          console.log(error);
        }
      })
      .output(path.join(os.tmpdir(), `${ctx.message?.voice?.file_id}.mp3`))
      .run();
  } catch (error) {
    console.log(error);
  }
};

export { app };
