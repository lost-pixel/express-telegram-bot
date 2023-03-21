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

import { Bot, session } from "grammy";
import { PsqlAdapter } from "@grammyjs/storage-psql";
import { hydrateFiles } from "@grammyjs/files";
import { limit } from "@grammyjs/ratelimiter";
import { MenuTemplate, MenuMiddleware } from "grammy-inline-menu";

import { MyContext, ChatHistoryItem } from "./types";
import { COMPLETION_PARAMS, client, initialSession } from "./utils";
import { env } from "./utils";
import { config } from "../config";

const app = express();

app.use(cors());
app.use(helmet());
app.use(express.json());

Sentry.init({
  dsn: env.SENTRY_DSN,
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
  await client.connect();

  const settingsMenu = new MenuTemplate<MyContext>("Settings for this chat:");

  settingsMenu.toggle("Short replies", "Short replies", {
    set(ctx, newState) {
      if (ctx.session.settings) {
        ctx.session.settings.skipProse = newState;
        return true;
      } else {
        ctx.session.settings = {
          skipProse: newState
        };
        return ctx.session.settings.skipProse;
      }
    },
    isSet: (ctx) => !!ctx.session.settings?.skipProse
  });

  const modeMenu = new MenuTemplate<MyContext>(
    "Mode of chatting with the bot:"
  );

  modeMenu.select(
    "select",
    modes.map((mode) => mode.name),
    {
      async set(ctx, key) {
        ctx.session.mode = key;
        await ctx.reply(`You are chatting with ${key}`);
        return true;
      },
      isSet: (ctx, key) => key === ctx.session.mode,
      columns: 2
    }
  );

  const bot = new Bot<MyContext>(env.TELEGRAM_TOKEN);

  bot.use(limit());

  bot.api.config.use(hydrateFiles(bot.token));

  bot.use(
    session({
      initial: () => initialSession,
      storage: await PsqlAdapter.create({ tableName: "sessions", client })
    })
  );

  const settingsMenuMiddleware = new MenuMiddleware<MyContext>(
    "settings-menu/",
    settingsMenu
  );

  bot.use(settingsMenuMiddleware.middleware());

  const modeMenuMidleware = new MenuMiddleware<MyContext>(
    "modes-menu/",
    modeMenu
  );

  bot.use(settingsMenuMiddleware.middleware());
  bot.use(modeMenuMidleware.middleware());

  bot.command("debug", (ctx) => {
    ctx.reply(JSON.stringify(ctx.session, null, 2));
  });

  bot.command("settings", (ctx) => settingsMenuMiddleware.replyToContext(ctx));
  bot.command("mode", (ctx) => modeMenuMidleware.replyToContext(ctx));

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
      ctx.session.chatHistory = [
        {
          role: "system",
          content: modes.find(
            (m) => m.name === ctx.session.mode || m.code === ctx.session.mode
          )?.promptStart as string
        }
      ];

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
        content: modes.find((m) => m.name === ctx.session.mode)
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
  try {
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
  } catch (error: unknown) {
    //@ts-expect-error - error is not a string
    console.log(error.response?.data);
  }
};

const getPrompt = (ctx: MyContext) => {
  const prompt = `${ctx.message?.text}. ${
    ctx.session?.settings?.skipProse ? "Skip prose." : ""
  } Answer as: ${ctx.session?.mode}. Don't mention the mode in your answer.`;

  return prompt;
};

const replyWithChatCompletion = async (ctx: MyContext, completion: string) => {
  const parseMode = modes.find((m) => m.name === ctx.session.mode)?.parseMode;

  let parsedMessage;

  if (parseMode === "MarkdownV2") {
    parsedMessage = completion.replace(
      /(\[[^\][]*]\(http[^()]*\))|[_*[\]()~>#+=|{}.!-]/gi,
      (x, y) => (y ? y : "\\" + x)
    );
  } else {
    parsedMessage = completion;
  }

  await ctx.replyWithChatAction("typing");

  await ctx.reply(parsedMessage, {
    parse_mode: parseMode as "HTML" | "MarkdownV2"
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

if (!config.isTestEnvironment) {
  app.listen(config.port);
  console.info("App is listening on port:", config.port);
  console.info("Starting bot in long-polling mode");
}

export { app };
