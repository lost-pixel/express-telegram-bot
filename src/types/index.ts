import { FileFlavor } from "@grammyjs/files";
import { Context, SessionFlavor } from "grammy";

export type ChatHistoryItem = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type SessionData = {
  mode?: string;
  token?: string;
  messagesCount: number;
  chatHistory?: ChatHistoryItem[];
  settings?: {
    [key: string]: boolean;
  };
};

export type MyContext = FileFlavor<Context> & SessionFlavor<SessionData>;
