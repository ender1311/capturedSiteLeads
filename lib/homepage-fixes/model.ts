import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

// Which client runs a "google/..." model id: Dan's own Google AI Studio key when it is set,
// otherwise the AI Gateway (the id string). A LanguageModel object (tests) is used as is.
export function resolveModel(id: LanguageModel): LanguageModel {
  if (typeof id !== "string") return id;
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY && id.startsWith("google/")) return google(id.slice("google/".length));
  return id;
}
