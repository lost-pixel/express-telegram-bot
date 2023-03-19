import { Client } from "pg";
import { z } from "zod";
import { modes } from "../config/modes";
import * as dotenv from "dotenv"; // see https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import

dotenv.config();

export const envSchema = z.object({
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

export const env = envSchema.parse(process.env);

export const COMPLETION_PARAMS = {
  frequency_penalty: 0,
  presence_penalty: 0,
  temperature: 0.6,
  max_tokens: 1000,
  top_p: 1
};

export const client = new Client({
  user: env.PG_USER,
  host: env.PG_HOST,
  database: env.PG_DB,
  password: env.PG_PASSWORD,
  port: Number(env.PG_PORT),
  //add ssl related param

  ssl: {
    rejectUnauthorized: false
  }
});

const initialMode = "ASSISTANT";

export const initialSession = {
  mode: initialMode,
  messagesCount: 0,
  chatHistory: [
    {
      role: "system",
      content: modes.find((m) => m.code === initialMode)?.promptStart as string
    }
  ],
  settings: {
    skipProse: false
  }
};
