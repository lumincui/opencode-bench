import { generateObject } from "ai";
import { z } from "zod";
import { getZenLanguageModel } from "../src/zenModels.js";
import { Judge } from "../src/judges.js";

const schema = z.object({
  score: z.number().refine((v) => v === 0 || v === 1),
  rationale: z.string().min(1),
});

const userPrompt =
  "Evaluate: does the string 'hello world' contain the word 'hello'? Score 1 if yes, 0 if no.";

for (const id of Judge.all) {
  const t0 = Date.now();
  try {
    const { object } = await generateObject({
      model: getZenLanguageModel(id),
      schema,
      system: "You are a strict evaluator. Return only the structured object.",
      temperature: 0,
      prompt: userPrompt,
    });
    console.log(`[OK] ${id}  (${Date.now() - t0}ms)`, object);
  } catch (e) {
    console.error(`[FAIL] ${id}  (${Date.now() - t0}ms)`, (e as Error).message);
  }
}
