# sambaNova

`https://docs.sambanova.ai/docs/en/get-started/quickstart`

Prerequisites
Before you begin, ensure you have:
A SambaCloud account, or access to a SambaStack deployment through your system administrator.
Python 3, Node.js, or curl installed, depending on your preferred integration method.
1
Get your API key.

To generate an API key, go to the API keys and URLs page. When generating API keys, be sure to save them securely, as they can’t be viewed again.
You can generate and use up to 25 API keys.
2
Pick a model.

SambaCloud developers can view the available models and details on the SambaCloud model page.
SambaStack developers should consult with their system administrator to determine which models are available on their system. Model details can then be viewed on the SambaStack models page.
This guide uses gpt-oss-120b as an example for the remainder of these steps.
3
Make an API request.

You can make an inference request in multiple ways. See two examples below:
SambaNova SDK - Use Javascript or Python for a more flexible integration.
OpenAI client library – Use Javascript or Python for a more flexible integration.
CURL command – Send a request directly from the command line.
​
SambaNova SDK
To get started, choose your preferred programming language. Next, open a terminal and run the command to install the SambaNova SDK.

Javascript

Python
//ensure you have Node.js installed.
npm install sambanova
Next, copy the following code into a new file.

hello-world.js

hello_world.py
import SambaNova from "sambanova";

const client = new SambaNova({
  baseURL: "your-sambanova-base-url",
  apiKey: "your-sambanova-api-key",
});

const chatCompletion = await client.chat.completions.create({
  messages: [
    { role: "system", content: "Answer the question in a couple sentences." },
    { role: "user", content: "Share a happy story with me" },
  ],
  model: "gpt-oss-120b",
});

console.log(chatCompletion.choices[0].message.content);
After copying the code into the file, replace the placeholder strings "your-sambanova-base-url" and "your-sambanova-api-key" with your actual Base URL and API Key. Then, run the file in a terminal using the command shown below.

Javascript

Python
node hello-world.js
After running the program, you’ll see output similar to the following:
Here’s a happy story: One day, a little girl named Sophie found a lost puppy in her neighborhood and decided to take it home to care for it. As she nursed the puppy back to health, she named it Max and the two became inseparable best friends, going on adventures and playing together every day.
​
OpenAI client library
To get started, select your preferred programming language. Then, open a terminal window and run the command to install the OpenAI library.

Javascript

Python
//ensure you have Node.js installed.
npm install openai
Next, copy the following code into a new file.

hello-world.js

hello_world.py
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "your-sambanova-base-url",
  apiKey: "your-sambanova-api-key",
});

const chatCompletion = await client.chat.completions.create({
  messages: [
    { role: "system", content: "Answer the question in a couple sentences." },
    { role: "user", content: "Share a happy story with me" },
  ],
  model: "gpt-oss-120b",
});

console.log(chatCompletion.choices[0].message.content);
Once copied into the file, replace the string fields "your-sambanova-base-url" and "your-sambanova-api-key" with your base URL and API Key values. Then run the file with the command below in a terminal window.

Javascript

Python
node hello-world.js
After you run the program, you’ll see output similar to the following:
Here’s a happy story: One day, a little girl named Sophie found a lost puppy in her neighborhood and decided to take it home to care for it. As she nursed the puppy back to health, she named it Max and the two became inseparable best friends, going on adventures and playing together every day.
​
CURL command
In a terminal window, run the CURL command to make your first request to the API.
export API_KEY="your-api-key-here"
export URL="your-url-here"

curl -H "Authorization: Bearer $API_KEY" \
-H "Content-Type: application/json" \
-d '{
"messages": [
{"role": "system", "content": "Answer the question in a couple sentences."},
{"role": "user", "content": "Share a happy story with me"}
],
"stop": ["<|eot_id|>"],
"model": "gpt-oss-120b",
"stream": true, "stream_options": {"include_usage": true}
}' \
-X POST $URL
​
---

# sambaNova model rate limits
Rate limits are a mechanism to help manage SambaNova API usage to provide stable performance and reliable service. They limit how many times each user can call the SambaNova API within a given interval.
Rate limits are measured in:
RPM: Requests per minute
RPD: Requests per day
TPD: Tokens per day (Free tier only)
​
Basics
A request is defined by a call to the SambaNova API
You can hit either limit type (RPM or RPD) depending on which one you reach first
You will be notified in every request response what the status of your rate limits are (see rate limit response headers for more information)
If you hit a rate limit, the API returns an error message in the response (see API error codes)
​
SambaStack rate limits
For SambaStack deployments, rate limits are optional and applied to user groups by the administrator.
​
SambaCloud rate limit tiers
SambaNova provides a few different rate limit tier offerings:
Free Tier: Applied when there is no payment method linked with your account
Developer Tier: Applied when a payment method is linked with your account
For higher rate limit access, please contact the SambaNova sales team.
Please see the Billing page to link a payment method to your account.
Developer tier accounts are limited to 20M tokens per day across all models.
​
Production model rate limits
Production models are intended for use in production environments and meet SambaNova’s high standards for speed and quality.
Developer Tier
Free Tier
Developer	Model ID	Requests per minute (RPM)	Requests per day (RPD)
MiniMax	MiniMax-M2.5	60	12000
DeepSeek	DeepSeek-V3.1	60	12000
Meta	Meta-Llama-3.3-70B-Instruct	240	48000
OpenAI	gpt-oss-120b	60	12000
​
Preview model rate limits
Preview models are intended for evaluation purposes and developer experimentation only, and should not be used in production environments. These models have limited capacity and may be removed at short notice.
Developer Tier
Free Tier
Developer	Model ID	Requests per minute (RPM)	Requests per day (RPD)
Meta	Llama-4-Maverick-17B-128E-Instruct	60	12000
DeepSeek	DeepSeek-V3.2	60	12000
​
Rate limit response headers
These headers are found in every request response and give information about the current status of rate limit usage.
​
RPM (Requests per minute)
x-ratelimit-limit-requests — Maximum requests allowed per minute
x-ratelimit-remaining-requests — Remaining requests in current minute
x-ratelimit-reset-requests — Time until reset
​
RPD (Requests per day)
x-ratelimit-limit-requests-day — Maximum requests allowed per day
x-ratelimit-remaining-requests-day — Remaining requests in current day
x-ratelimit-reset-requests-day — Time until reset