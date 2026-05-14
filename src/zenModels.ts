import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { generateObject } from "ai";

type GenerateObjectOptions = Parameters<typeof generateObject>[0];
type SupportedModel = NonNullable<GenerateObjectOptions["model"]>;

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_PREFIX = "opencode/";
const API_KEY_ENV_VARS = ["OPENCODE_API_KEY"];

const MINIMAX_PREFIX = "minimax-cn-coding-plan/";
const MINIMAX_AUTH_KEY = "minimax-cn-coding-plan";
const MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic/v1";
const MINIMAX_AUTH_PATH = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");

let minimaxAnthropic: ReturnType<typeof createAnthropic> | undefined;

function getMinimaxKey(): string {
  const fromEnv = process.env.MINIMAX_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  let raw: string;
  try {
    raw = fs.readFileSync(MINIMAX_AUTH_PATH, "utf8");
  } catch (err) {
    assert(
      false,
      `Cannot read opencode auth file at ${MINIMAX_AUTH_PATH}; set MINIMAX_API_KEY env var or run 'opencode auth login ${MINIMAX_AUTH_KEY}' (${(err as Error).message})`,
    );
  }
  const auth = JSON.parse(raw) as Record<string, { type?: string; key?: string }>;
  const entry = auth[MINIMAX_AUTH_KEY];
  assert(
    entry?.type === "api" && typeof entry.key === "string" && entry.key.length > 0,
    `auth.json has no usable '${MINIMAX_AUTH_KEY}' api credential; run 'opencode auth login ${MINIMAX_AUTH_KEY}' or set MINIMAX_API_KEY`,
  );
  return entry.key as string;
}

function ensureMinimaxAnthropic(): ReturnType<typeof createAnthropic> {
  if (minimaxAnthropic) return minimaxAnthropic;
  minimaxAnthropic = createAnthropic({
    apiKey: getMinimaxKey(),
    baseURL: MINIMAX_BASE_URL,
  });
  return minimaxAnthropic;
}

type ProviderBundle = {
  openai: ReturnType<typeof createOpenAI>;
  openaiCompatible: ReturnType<typeof createOpenAICompatible>;
  anthropic: ReturnType<typeof createAnthropic>;
};

const modelCache = new Map<string, SupportedModel>();
let providers: ProviderBundle | undefined;

function resolveZenApiKey(): string {
  for (const envName of API_KEY_ENV_VARS) {
    const value = process.env[envName]?.trim();
    if (value) {
      return value;
    }
  }

  assert(
    false,
    [
      "Missing OpenCode Zen API key.",
      "Set OPENCODE_API_KEY before running the CLI.",
      "See https://opencode.ai/docs/zen/ for instructions.",
    ].join(" "),
  );
}

function resolveZenBaseUrl(): string {
  const configured = process.env.OPENCODE_ZEN_BASE_URL?.trim();
  if (!configured) {
    return DEFAULT_BASE_URL;
  }

  return configured.replace(/\/+$/, "");
}

function ensureProviders(): ProviderBundle {
  if (providers) {
    return providers;
  }

  const apiKey = resolveZenApiKey();
  const baseURL = resolveZenBaseUrl();

  providers = {
    openai: createOpenAI({
      apiKey,
      baseURL,
    }),
    openaiCompatible: createOpenAICompatible({
      apiKey,
      baseURL,
      name: "opencode",
    }),
    anthropic: createAnthropic({
      apiKey,
      baseURL,
    }),
  };

  return providers;
}

function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  assert(trimmed.length > 0, "Model identifier cannot be empty.");

  if (trimmed.startsWith(OPENCODE_PREFIX)) {
    return trimmed.slice(OPENCODE_PREFIX.length);
  }

  return trimmed;
}

function inferEndpoint(modelId: string): "responses" | "anthropic" | "chat" {
  const lower = modelId.toLowerCase();

  if (lower.startsWith("claude")) {
    return "anthropic";
  }

  if (lower.startsWith("gpt")) {
    return "responses";
  }

  if (
    lower.startsWith("kimi") ||
    lower.startsWith("grok") ||
    lower.startsWith("qwen")
  ) {
    return "chat";
  }

  return "responses";
}

export function getZenLanguageModel(modelId: string): SupportedModel {
  const trimmed = modelId.trim();
  if (trimmed.startsWith(MINIMAX_PREFIX)) {
    const cacheKey = `minimax:${trimmed}`;
    const cached = modelCache.get(cacheKey);
    if (cached) return cached;
    const minimaxModelName = trimmed.slice(MINIMAX_PREFIX.length);
    const m = ensureMinimaxAnthropic()(minimaxModelName) as unknown as SupportedModel;
    modelCache.set(cacheKey, m);
    return m;
  }

  const normalized = normalizeModelId(modelId);
  const cacheKey = `zen:${normalized}`;

  if (modelCache.has(cacheKey)) {
    return modelCache.get(cacheKey)!;
  }

  const { openai, openaiCompatible, anthropic } = ensureProviders();
  const endpoint = inferEndpoint(normalized);

  let model: SupportedModel;
  switch (endpoint) {
    case "anthropic":
      model = anthropic(normalized) as unknown as SupportedModel;
      break;
    case "responses":
      model = openai.responses(normalized) as unknown as SupportedModel;
      break;
    case "chat":
    default:
      model = openaiCompatible.chatModel(
        normalized,
      ) as unknown as SupportedModel;
      break;
  }

  modelCache.set(cacheKey, model);
  return model;
}
