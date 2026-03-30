export type Page =
  | "dashboard"
  | "collections"
  | "users"
  | "files"
  | "knowledge"
  | "sessions"
  | "forms"
  | "workflows"
  | "rules"
  | "agents"
  | "crons"
  | "docs"
  | "logs";

export interface Bot {
  id: string;
  name: string;
  botStatus: string;
  botUsername: string;
  botName: string;
  thinking: boolean;
}

export interface Overview {
  bots: { id: string; name: string; botStatus: string }[];
  users: number;
  collections: number;
  rows: number;
  files: number;
  knowledge: number;
  sessions: number;
}
