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
import path from "path";
import os from "os";
import fs from "fs";
import https from "https";
import ffmpeg from "fluent-ffmpeg";

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
  settings?: {
    [key: string]: boolean;
  };
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

bot.command("settings", (ctx) => {
  type SettingOption = {
    name: string;
    code: string;
  };

  const settingsOptions: SettingOption[] = [
    { name: "Be concise ⏩", code: "skipProse" }
  ];
  const modeButtons = settingsOptions.map((setting) => {
    // split into arrays of two
    return Markup.button.callback(
      `${ctx.session?.settings?.[setting.code] ? `✅  ` : ""}${setting.name}`,
      `settings-switch-event__${setting.code}`
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

  return ctx.reply("Choose your settings!", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(modeButtonsChunks)
  });
});

const modesRegexp = /mode-switch-event__(.*)/;

bot.action(modesRegexp, (ctx) => {
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

const settingsRegexp = /settings-switch-event__(.*)/;

bot.action(settingsRegexp, (ctx) => {
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
            console.log(
              ctx.session?.settings && ctx.session?.settings[ctx.match[1]]
            );
            return row.map((button) => {
              return {
                ...button,
                text: button.text.replace(
                  ctx.session?.settings && ctx.session?.settings[ctx.match[1]]
                    ? "✅  "
                    : "",
                  ctx.session?.settings && ctx.session?.settings[ctx.match[1]]
                    ? ""
                    : "✅  "
                )
              };
            });
          }
        ) ?? [])
      ]
    }
  );

  if (ctx.session?.settings) {
    ctx.session.settings[ctx.match[1]] = !ctx.session?.settings?.[ctx.match[1]];
  } else {
    ctx.session = {
      settings: {
        [ctx.match[1]]: true
      },
      messagesCount: 0
    };
  }

  console.log(ctx.session);
  ctx.reply(`Settings updated!`);
});

bot.on("voice", async (ctx) => {
  ctx.reply("🔊 Processing your voice message...");
  return ctx.telegram
    .getFileLink(ctx.message.voice.file_id)
    .then((url) => {
      console.log("--- url: " + url);
      // create a temp file path
      const tempFilePath = path.join(
        os.tmpdir(),
        `${ctx.message.voice.file_id}.ogg`
      );
      // download the file

      const file = fs.createWriteStream(tempFilePath);

      https
        .get(url, function (response) {
          response.pipe(file);
          file.on("finish", function () {
            console.log(`File downloaded to ${tempFilePath}`);
            // use fluent-ffmpeg to convert .ogg file to .mp3 format

            try {
              ffmpeg(tempFilePath)
                .toFormat("mp3")

                .on("start", function (commandLine) {
                  console.log("Spawned Ffmpeg with command: " + commandLine);
                })
                .on("error", function (err) {
                  console.log(
                    "An error occurred while converting with mmpeg: " +
                      err.message
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
                      path.join(os.tmpdir(), `${ctx.message.voice.file_id}.mp3`)
                    ) as any,
                    "whisper-1"
                  );

                  ctx.reply(`You asked: \n${transcript.data.text}`);

                  if (!ctx.session) {
                    ctx.session = {
                      mode: selectedMode,
                      messagesCount: 0
                    };
                  }

                  if (
                    ctx.session.messagesCount >=
                    Number(env.NO_OAI_TOKEN_MESSAGE_LIMIT)
                  ) {
                    if (!ctx.session.token) {
                      ctx.reply(
                        `You have reached the limit of ${env.NO_OAI_TOKEN_MESSAGE_LIMIT} messages without an OpenAI API token. You can easily get a token for free at https://platform.openai.com/account/api-keys`
                      );
                      return;
                    }
                  }

                  try {
                    await ctx.sendChatAction("typing");

                    if (!ctx.session.chatHistory) {
                      ctx.session.chatHistory = [
                        {
                          role: "system",
                          content: modes.find((m) => m.code === selectedMode)
                            ?.promptStart as string
                        },
                        { role: "user", content: transcript.data.text }
                      ];
                    } else {
                      ctx.session.chatHistory.push({
                        role: "user",
                        content: transcript.data.text
                      });
                    }

                    const completion = await openai.createChatCompletion({
                      model: "gpt-3.5-turbo",
                      messages: ctx.session.chatHistory,
                      ...COMPLETION_PARAMS
                    });

                    ctx.session.messagesCount = ctx.session.messagesCount + 1;

                    if (completion.data.choices[0].message) {
                      ctx.session.chatHistory?.push(
                        completion.data.choices[0].message
                      );
                    }

                    ctx.reply(
                      completion.data.choices[0].message?.content as string,
                      {
                        parse_mode: modes.find((m) => m.code === selectedMode)
                          ?.parseMode as "HTML" | "MarkdownV2"
                      }
                    );
                  } catch (error) {
                    console.log(error);
                  }
                })
                .output(
                  path.join(os.tmpdir(), `${ctx.message.voice.file_id}.mp3`)
                )
                .run();
            } catch (error) {
              console.log(error);
            }
          });
        })
        .on("error", function (err) {
          console.error(`Error downloading file: ${err.message}`);
        });
    })
    .catch((err) => {
      console.log("*** error ***");
      console.log(err);
    });
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

    const prompt = `${ctx.message.text}. ${
      ctx.session?.settings?.skipProse ? "Skip prose" : ""
    }`;

    if (!ctx.session.chatHistory) {
      ctx.session.chatHistory = [
        {
          role: "system",
          content: modes.find((m) => m.code === selectedMode)
            ?.promptStart as string
        },
        { role: "user", content: prompt }
      ];
    } else {
      ctx.session.chatHistory.push({ role: "user", content: prompt });
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
