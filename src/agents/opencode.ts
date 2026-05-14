import process from "node:process";
import detectPort from "detect-port";
import {
  createOpencode,
  type Config as OpencodeConfig,
} from "@opencode-ai/sdk";
import type { Agent } from "./index.js";

// Set OpenCode config before server starts to ensure timeout is applied
const candidatePrompt = process.env.OPENCODE_BENCH_AGENT_PROMPT;
const opencodeConfig = {
  permission: {
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    external_directory: "allow",
  },
  provider: {
    opencode: {
      options: {
        timeout: false, // disable timeout for OpenCode provider requests
      },
    },
  },
  ...(candidatePrompt
    ? { agent: { build: { prompt: candidatePrompt } } }
    : {}),
} satisfies OpencodeConfig;

// CRITICAL: Set via environment variable BEFORE importing/creating anything
// The SDK reads this when spawning the server process
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(opencodeConfig);

const opencode = await createOpencode({
  port: await detectPort(4096),
  timeout: 1_500_000, // 25 minutes timeout for server startup
  config: opencodeConfig,
});

const sessionCache = new Map<string, string>();

export const models: string[] = [
  "opencode/gpt-5-codex",
  "opencode/gpt-5.1-codex",
  "opencode/claude-sonnet-4-5",
  "opencode/claude-opus-4-5",
  "opencode/glm-4.6",
  "opencode/glm-4.7-free",
  "opencode/gemini-3-pro",
  "opencode/qwen3-coder",
  "opencode/kimi-k2",
  "opencode/grok-code",
  "opencode/alpha-gd4",
  "minimax-cn-coding-plan/MiniMax-M2.7",
];

function sessionKey(model: string, cwd: string): string {
  return `${cwd}::${model}`;
}

const opencodeAgent: Agent.Definition = {
  async run(model, prompt, options) {
    options.logger.log(`opencode --model ${model} ${prompt}`);

    const cacheKey = sessionKey(model, options.cwd);

    options.logger.log(`Creating session...`);
    let sessionID = sessionCache.get(cacheKey);
    if (!sessionID) {
      const { data: session } = await opencode.client.session.create({
        query: { directory: options.cwd },
        throwOnError: true,
      });
      sessionID = session.id;
      sessionCache.set(cacheKey, sessionID);
    }

    options.logger.log(`Prompting session ${sessionID}...`);
    const [providerID, modelID] = model.split("/");
    const actions: string[] = [];
    const usage = {
      input: 0,
      output: 0,
      cost: 0,
    };
    try {
      const { data, error } = await opencode.client.session.prompt({
        path: { id: sessionID! },
        query: { directory: options.cwd },
        body: {
          model: {
            providerID,
            modelID,
          },
          parts: [{ type: "text", text: prompt }],
        },
      });

      if (error) throw error;
      options.logger.debug(`Data: ${JSON.stringify(data)}`);

      const info = data.info;
      if (info) actions.push(JSON.stringify(info));
      usage.input = info?.tokens?.input ?? 0;
      usage.output = info?.tokens?.output ?? 0;
      usage.cost = info?.cost ?? 0;
      options.logger.debug(`Usage: ${JSON.stringify(usage)}`);

      if (!data.parts?.length)
        throw new Error(
          options.logger.format("Response did not include assistant parts."),
        );
      data.parts.forEach((part) => actions.push(JSON.stringify(part)));
      options.logger.debug(`Actions: ${JSON.stringify(actions)}`);
    } catch (error: any) {
      sessionCache.delete(cacheKey);
      options.logger.error("Error in opencode agent: ", error);
      throw error;
    }

    return { actions, usage };
  },
  cleanup() {
    opencode.server.close();
  },
};

export default opencodeAgent;
