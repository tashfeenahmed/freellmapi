#!/usr/bin/env node
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const MODEL = process.env.BEDROCK_MODEL_ID || 'openai.gpt-oss-120b-1:0';

if (!OPENAI_API_KEY || !OPENAI_BASE_URL) {
  console.error('Missing environment variables. Set OPENAI_API_KEY and OPENAI_BASE_URL');
  process.exit(2);
}

async function main() {
  try {
    const url = OPENAI_BASE_URL.replace(/\/+$/,'') + '/responses';
    const body = {
      model: MODEL,
      input: 'اكتب جملة ترحيبية قصيرة بالعربية'
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body),
      // timeout not built-in in fetch; rely on Node timeout
    });

    const text = await res.text();
    console.log('HTTP', res.status, res.statusText);
    try {
      console.log('Response JSON:', JSON.parse(text));
    } catch (e) {
      console.log('Response body (raw):', text);
    }
  } catch (err) {
    console.error('Request error:', err);
    process.exit(1);
  }
}

main();
import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;
  const modelId = process.env.BEDROCK_MODEL_ID || "openai.gpt-oss-120b";

if (!apiKey || !baseURL) {
  console.error(
    "Error: Missing environment variables.\n" +
    "Required:\n" +
    "  OPENAI_API_KEY: Your Bedrock API key\n" +
    "  OPENAI_BASE_URL: https://bedrock-mantle.<region>.api.aws/v1\n" +
    "  BEDROCK_MODEL_ID (optional): Model identifier (default: openai.gpt-oss-120b-1:0)"
  );
  process.exit(1);
}

console.log("Configuration:");
console.log(`  API Key: ${apiKey.slice(0, 20)}...`);
console.log(`  Base URL: ${baseURL}`);
console.log(`  Model: ${modelId}`);
console.log("");

const client = new OpenAI({
  apiKey: apiKey,
  baseURL: baseURL,
});

async function testBedrockConnection() {
  try {
    console.log("Sending request to Bedrock...\n");
    
    // Using responses API (simpler test)
    const response = await client.responses.create({
      model: modelId,
      input: "Hello Bedrock! Respond briefly in English.",
    });
    
    console.log("✓ Response received successfully!\n");
    console.log("Response:", response);
    
  } catch (error) {
    console.error("✗ Error calling Bedrock:");
    if (error.response) {
      console.error(`  Status: ${error.response.status}`);
      console.error(`  Headers: ${JSON.stringify(error.response.headers)}`);
      console.error(`  Data: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`  ${error.message}`);
    }
    process.exit(1);
  }
}

testBedrockConnection();
