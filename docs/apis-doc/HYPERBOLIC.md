# Quickstart Guide

Getting Started with Hyperbolic Serverless Inference

Once we have created a Hyperbolic account, API key, and configured your billing, we can send our first inference request!

# Text Generation

### Llama 3.1 70B Instruct

```bash Shell
curl -X POST "https://api.hyperbolic.xyz/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $HYPERBOLIC_API_TOKEN" \
    -d '{
        "messages": [
            {
                "role": "system",
        	"content": "You are a helpful and polite assistant."
            },
            {
                "role": "user",
                "content": "What is Chinese hotpot?"
            }
        ],
        "model": "meta-llama/Meta-Llama-3.1-70B-Instruct",
        "presence_penalty": 0,
        "temperature": 0.1,
        "top_p": 0.9,
        "stream": false
    }'
```

```py Python
import os
import openai

system_content = "You are a gourmet. Be descriptive and helpful."
user_content = "Tell me about Chinese hotpot"

client = openai.OpenAI(
    api_key="YOUR_HYPERBOLIC_API_TOKEN",
    base_url="https://api.hyperbolic.xyz/v1",
    )

chat_completion = client.chat.completions.create(
    model="meta-llama/Meta-Llama-3.1-70B-Instruct",
    messages=[
        {"role": "system", "content": system_content},
        {"role": "user", "content": user_content},
    ],
    temperature=0.7,
    max_tokens=1024,
)

response = chat_completion.choices[0].message.content
print("Response:\n", response)
```

```ts TypeScript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'YOUR_HYPERBOLIC_API_TOKEN',
  baseURL: 'https://api.hyperbolic.xyz/v1',
});

async function main() {
  const response = await client.chat.completions.create({
    messages: [
      {
        role: 'system',
        content: 'You are an expert travel guide.',
      },
      {
        role: 'user',
        content: 'Tell me fun things to do in San Francisco.',
      },
    ],
    model: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
  });

  const output = response.choices[0].message.content;
  console.log(output);
}

main();
```

# Image Generation

### Stable Diffusion

```bash Shell
curl -X POST "https://api.hyperbolic.xyz/v1/image/generation" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $HYPERBOLIC_API_TOKEN" \
    -d '{
      "model_name": "SDXL1.0-base",
      "prompt": "a photo of an astronaut riding a horse on mars",
      "height": 1024,
      "width": 1024,
      "backend": "auto"
    }' | jq -r ".images[0].image" | base64 -d > result.jpg
```

# Audio Generation

### Melo TTS

```bash Shell
curl -X POST "https://api.hyperbolic.xyz/v1/audio/generation" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $HYPERBOLIC_API_TOKEN" \
    -d '{
      "text": "Hi! Welcome to Hyperbolic."
    }' | jq -r ".audio" | base64 -d > result.mp3
```

---



# AI Inference Pricing

# Basic Tier

* **Usage**: Basic users can make up to 60 requests per minute, while Pro-tier users (minimum $5 account deposit required) are allowed up to 600 requests per minute. For increased rate limits, please contact [support@hyperbolic.xyz](mailto:support@hyperbolic.xyz).
  * **Important disclaimer:** Each source IP address will be limited to 600/min to prevent DDoS attacks.
  * **Special rate limits**:
    * meta-llama/Meta-Llama-3.1-405B: Basic users - 5 requests/min; Pro users - 120 requests/min
    * meta-llama/Meta-Llama-3.1-405B-Instruct: Basic users - 5 requests/min; Pro users - 120 requests/min
    * Flux.1 \[dev]: Basic users - 1 request/5 mins; Pro users - 50 requests/min
* **Features**: Access to text-to-text, text-to-speech, and text-to-image models, text-to-video models and fine-tuning services.
* **Cost**:
  * $1 of promotional credits for verifying your phone number in the platform.
  * Note that this $1 credit can not be used to rent GPUs, you must deposit $5 or more to do so.
  * **Models**
    * LLM Models
      * GPT OSS 120B (FP8): $0.3 per 1M tokens
      * GPT OSS 20B (FP8): $0.04 per 1M tokens
      * Llama 3.3 70B (FP8): $0.4 per 1M tokens
      * Llama 3.2 3B  (FP8): $0.1 per 1M tokens
      * Llama 3.1 405B (FP8): $4 per 1M token
      * Llama 3.1 405B parameters BASE (BF16): $4 per 1M tokens
      * Llama 3.1 8B (FP8): $0.1 per 1M tokens
      * Llama 3.1 70B (FP8): $0.4 per 1M tokens
      * Llama 3 70B (FP8): $0.4 per 1M tokens
      * Qwen 3 Next 80B A3b Thinking: $0.3 per 1M tokens
      * Qwen 3 Next 80B A3b Instruct: $0.3 per 1M tokens
      * Qwen 3 Coder 480B A35B (FP8): $2 per 1M tokens
      * Qwen 3 235B A22B (FP8): $0.4 per 1M tokens
      * Qwen 3 235B A22B Instruct 2507: $2 per 1M tokens
      * Qwen 2.5 72B (FP8): $0.4 per 1M tokens
      * Qwen 2.5 Coder 32B (FP8): $0.2 per 1M tokens
      * Qwen 2.5 VL 7B Instruct (BF16): $0.2 per 1M tokens
      * Qwen 2.5 VL 72B Instruct (BF16): $0.6 per 1M tokens
      * DeepSeek V3 0324 (FP8): $1.25 per 1M tokens
      * DeepSeek V3 (FP8): $0.25 per 1M tokens
      * DeepSeek R1 (FP8): $2 per 1M tokens
      * DeepSeek R1 0528 (FP8): $3 per 1M tokens
      * Hermes 3 70B (FP8): $0.4 per 1M tokens
      * Kimi-K2 (FP8): $2 per 1M tokens
    * Image models
      * Flux.1: $0.01 per image
      * SDXL 1.0: $0.01 per image
      * SDXL 1.0 Turbo: $0.01 per image
      * Stable Diffusion 1.5: $0.01 per image
      * Stable Diffusion 2.0: $0.01 per image
      * Segmind SD-1B: $0.01 per image
  * **Text-to-image:**
    * **Pricing Formula:** $Base Rate *(width/1024)* (height/1024) \* (steps/25) per image
    * **How it works?**
      * **Base Rate for SD family and Flux Dev:** $0.01 is the cost for generating a standard image at 1024x1024 pixels with 25 steps
      * **Image Size Adjustment:** The price scales with the width and height of the image. For example:
        * **512x512 pixels:** The price would be $Base Rate *(512/1024)* (512/1024) \* (steps/25)
        * **2048x2048 pixels:** The price would be $Base Rate *(2048/1024)* (2048/1024) \* (steps/25)
      * **Step Adjustment:** The price also scales based on the number of steps used in generating the image:
        * **25 steps:** The multiplier is 1 (i.e., steps/25 = 25/25 = 1)
        * **50 steps:** The multiplier is 2 (i.e., steps/25 = 50/25 = 2)
  * **VLMs:**
    * NVIDIA Nemotron Nano 12B v2 VL (BF16): $0.20 per 1M tokens
    * Pixtral 12B (BF16): $0.1 per 1M tokens
    * Qwen2.5-VL-7B-Instruct (BF16): $0.2 per 1M tokens
    * Qwen2.5-VL-72B-Instruct (BF16): $0.6 per 1M tokens
  * **Text-to-speech:**
    * Melo TTS: $5.00 per 1M characters
  * **Text-to-video:**
    * Price TBD
* **Purpose**: Cater to startups and small to medium-sized enterprises that need higher throughput and advanced features.

<br />

# Enterprise Tier

* **Usage**: Unlimited Requests
* **Features**: Full suite of AI models, dedicated support, custom SLAs, or dedicated instances.
* **Dedicated Instances**:
  * **Hourly Hosting Fee**:
    * H100 SXM: $3.20
    * H100 PCIe: $3.00
    * A100 SXM: $1.80
    * A100 PCIe: $1.60
    * 3090: $0.30
    * 4090: $0.50
* **Custom Model Hosting:** Host and optimize your custom AI models, resulting in high throughput and lower latency.
* **Purpose**: Serve large enterprises with substantial and specific requirements, offering them scalability and dedicated resources.

<br />

# Notes

## Understanding FP8 vs BF16

When choosing between FP8 and BF16 for model inference, it’s about balancing speed, precision, and cost.

**BF16 (16-bit Brain Floating Point):**

BF16 is the precision level at which the model was originally trained. BF16 offers the best in precision and performance. It retains more accuracy, making it suitable for tasks where precision is critical—like medical diagnostics or scientific research. With BF16, you get reliable results without compromising speed, though it comes at a slightly higher cost.

**FP8 (8-bit Floating Point):**

FP8 is all about efficiency. It’s fast, lean, and perfect for applications where speed matters more than precision. FP8 helps you scale at a lower cost, making it ideal for high-throughput needs.

In Summary:

FP8 is your go-to for cost-effective scaling with speed. BF16 is for when precision can’t be compromised, even if it means a bit more on the price tag. It’s all about what your application demands.

## Understanding Base vs. Instruct Models

When deciding between base models and instruct models, it’s about understanding the level of guidance and the complexity of the tasks you need to solve.

**Base Models:**

Base models are the foundation—they’re versatile and trained on a broad range of data. They can handle a wide variety of tasks but don’t have specific instructions baked in. Think of them as powerful tools that can be shaped and directed however you need.

**Instruct Models:**

Instruct models take things a step further. They’re base models that have been specifically trained on pairs of instructions and responses. This means when you give an instruct model a command, it knows to follow that command precisely. It’s like having a model that already understands how to respond to specific tasks right out of the box.

In Summary:

Base models offer flexibility and can be adapted to many uses. Instruct models are pre-trained to follow instructions directly, making them ideal for tasks where you want immediate, accurate responses.

**Note:**

If you require an invoice for the compute credits you've purchased, please email [support@hyperbolic.xyz](mailto:support@hyperbolic.xyz) with the necessary invoicing details.