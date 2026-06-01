import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;

if (!apiKey || !baseURL) {
  console.error("Missing OPENAI_API_KEY or OPENAI_BASE_URL");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: apiKey,
  baseURL: baseURL,
});

// Try common model variants
const modelVariants = [
  "openai.gpt-oss-120b",
  "openai.gpt-oss-120b-1:0",
  "openai.gpt-oss-120b-instruct",
  "openai.gpt-oss-20b",
];

console.log("Testing model variants against Bedrock...\n");

for (const model of modelVariants) {
  process.stdout.write(`Testing ${model}... `);
  try {
    const response = await client.responses.create({
      model: model,
      input: "Hi",
    });
    console.log("✓ SUCCESS");
    console.log(`  Response: ${JSON.stringify(response).slice(0, 100)}...\n`);
    process.exit(0);
  } catch (error) {
    if (error.response?.status === 404) {
      console.log("✗ Not found");
    } else {
      console.log(`✗ Error: ${error.message}`);
    }
  }
}

console.log("\nNo working model found. Consult Bedrock console for available models.");
