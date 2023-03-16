import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { Telegraf, session, Context, Markup } from "telegraf";
import { OpenAIApi, Configuration } from "openai";
import { z } from "zod";
import { config } from "../config";

import { modes } from "./config/modes";

import { Postgres } from "@telegraf/session/pg";
import { SessionStore } from "telegraf/typings/session";
import { InlineKeyboardButton } from "telegraf/typings/core/types/typegram";

const envSchema = z.object({
  TELEGRAM_TOKEN: z.string().nonempty(),
  OPEN_AI_PLATFORM_TOKEN: z.string().nonempty(),
  NO_OAI_TOKEN_MESSAGE_LIMIT: z.string().nonempty(),
  PG_HOST: z.string().nonempty(),
  PG_USER: z.string().nonempty(),
  PG_PASSWORD: z.string().nonempty(),
  PG_PORT: z.string().nonempty(),
  PG_DB: z.string().nonempty()
});
const env = envSchema.parse(process.env);

const store = Postgres({
  host: env.PG_HOST,
  user: env.PG_USER,
  password: env.PG_PASSWORD,
  port: Number(env.PG_PORT),
  database: env.PG_DB,
  config:
    process.env.NODE_ENV === "production"
      ? {
          ssl: {
            rejectUnauthorized: false
          }
        }
      : undefined
}) as SessionStore<object>;

const COMPLETION_PARAMS = {
  frequency_penalty: 0,
  presence_penalty: 0,
  temperature: 0.6,
  max_tokens: 1000,
  top_p: 1
};

interface SessionData {
  mode?: string;
  token?: string;
  messagesCount: number;
  chatHistory?: {
    role: "system" | "user" | "assistant";
    content: string;
  }[];
}

interface MyContext extends Context {
  session?: SessionData;
}

const selectedMode = "ASSISTANT";

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

bot.start((ctx) => {
  ctx.reply(
    `Hey, I'm <b>Ed GPT</b>! I'm a bot that can create textual content based on your input based on ChatGPT model. To get started, send me a message with the text you want me to generate content for. You can try it out for <b>${env.NO_OAI_TOKEN_MESSAGE_LIMIT}</b>  messages without an <b>OpenAI API token</b>.\n\nAfter that, you'll need to provide a token to continue using the bot.\n\nYou can easily get a token for free at https://platform.openai.com/account/api-keys`,
    {
      parse_mode: "HTML"
    }
  );
});

bot.use(session({ store }));

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
    const tokenFromArg = ctx.message.text.split(" ")[1];

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

bot.command("mode", (ctx) => {
  const modeButtons = modes.map((mode) => {
    // split into arrays of two
    return Markup.button.callback(
      `${ctx.session?.mode === mode.code ? `✅  ` : ""}${mode.name}`,
      `mode-switch-event__${mode.code}`
    );
  });

  const modeButtonsChunks = modeButtons.reduce(
    (resultArray, item, index) => {
      const chunkIndex = Math.floor(index / 2);

      if (!resultArray[chunkIndex]) {
        resultArray[chunkIndex] = []; // start a new chunk
      }

      resultArray[chunkIndex].push(item);

      return resultArray;
    },
    [] as InlineKeyboardButton.CallbackButton[][] // start with the empty array
  );

  return ctx.reply("Choose your AI assistant!", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(modeButtonsChunks)
  });
});

const regexp = /mode-switch-event__(.*)/;

bot.action(regexp, (ctx) => {
  ctx.telegram.editMessageReplyMarkup(
    ctx.update?.callback_query?.message?.chat.id,
    ctx.update?.callback_query?.message?.message_id,
    undefined,
    {
      //edit initial array, remove tick from previously selected mode add tick to newly selected mode

      inline_keyboard: [
        // @ts-expect-error I know better what exists here
        ...(ctx.update?.callback_query?.message?.reply_markup?.inline_keyboard?.map(
          (row: InlineKeyboardButton.CallbackButton[]) => {
            return row.map((button) => {
              console.log(button);
              // @ts-expect-error I know better what exists here
              if (button.callback_data === ctx.update?.callback_query?.data) {
                return {
                  ...button,
                  text: `✅  ${button.text}`
                };
              } else {
                return {
                  ...button,
                  text: button.text.replace("✅  ", "")
                };
              }
            });
          }
        ) ?? [])
      ]
    }
  );

  if (ctx.session) {
    ctx.session.mode = ctx.match[1];
  } else {
    ctx.session = {
      mode: ctx.match[1],
      messagesCount: 0
    };
  }
  ctx.reply(
    `You are now chatting with ${
      modes.find((mode) => mode.code === ctx.match[1])?.name
    }`
  );
});

bot.on("text", async (ctx) => {
  if (!ctx.session) {
    ctx.session = {
      mode: selectedMode,
      messagesCount: 0
    };
  }

  if (ctx.session.messagesCount >= Number(env.NO_OAI_TOKEN_MESSAGE_LIMIT)) {
    if (!ctx.session.token) {
      ctx.reply(
        `You have reached the limit of ${env.NO_OAI_TOKEN_MESSAGE_LIMIT} messages without an OpenAI API token. You can easily get a token for free at https://platform.openai.com/account/api-keys`
      );
      return;
    }
  }

  try {
    const configuration = new Configuration({
      apiKey: ctx.session.token ?? env.OPEN_AI_PLATFORM_TOKEN
    });

    const openai = new OpenAIApi(configuration);

    await ctx.sendChatAction("typing");

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

    ctx.session.messagesCount = ctx.session.messagesCount + 1;

    if (completion.data.choices[0].message) {
      ctx.session.chatHistory?.push(completion.data.choices[0].message);
    }

    ctx.reply(completion.data.choices[0].message?.content as string, {
      parse_mode: modes.find((m) => m.code === selectedMode)?.parseMode as
        | "HTML"
        | "MarkdownV2"
    });

    console.log("Session", ctx.session);
  } catch (error) {
    console.log(error);
  }
});

bot.launch();

if (!config.isTestEnvironment) {
  app.listen(config.port);
  console.info("App is listening on port:", config.port);
}

export { app };
