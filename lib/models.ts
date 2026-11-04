// Curated models for report copywriting, priced from the AI Gateway catalog
// (per-token USD). Cost estimates assume ~5,600 input + ~1,500 output tokens
// per report (homepage fixes: main call, repair and look check).

export const DEFAULT_MODEL = "google/gemini-3.8-flash";

export type ModelOption = {
  id: string;
  label: string;
  description: string;
  inputPerToken: number;
  outputPerToken: number;
};

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash (default)",
    description: "Writes the homepage fixes report.",
    inputPerToken: 0.00000075,
    outputPerToken: 0.00000375,
  },
  {
    id: "google/gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    description: "Cheaper Gemini option.",
    inputPerToken: 0.0000003,
    outputPerToken: 0.0000025,
  },
  {
    id: "google/gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite — Budget",
    description: "Fast and dirt cheap. Solid copy; the price makes volume a non-issue.",
    inputPerToken: 0.0000001,
    outputPerToken: 0.0000004,
  },
  {
    id: "google/gemini-3-pro-preview",
    label: "Gemini 3 Pro — Best Gemini",
    description: "Google's flagship. Strong reasoning and specificity in the diagnosis.",
    inputPerToken: 0.000002,
    outputPerToken: 0.000012,
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5 — Best Claude",
    description: "Excellent warm, human copywriting voice — a strong fit for Maggie's tone.",
    inputPerToken: 0.000002,
    outputPerToken: 0.00001,
  },
  {
    id: "openai/gpt-5.6-sol",
    label: "GPT-5.6 Sol — Best OpenAI",
    description: "OpenAI's flagship writer. Priciest of the set.",
    inputPerToken: 0.000005,
    outputPerToken: 0.00003,
  },
];

export const TOKENS_PER_REPORT = { input: 5600, output: 1500 };

export function costPerReport(m: ModelOption): number {
  return TOKENS_PER_REPORT.input * m.inputPerToken + TOKENS_PER_REPORT.output * m.outputPerToken;
}
