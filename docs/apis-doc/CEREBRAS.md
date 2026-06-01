# CEREBRAS_API

This Quickstart guide is designed to assist you in making your first API call. If you are an experienced AI applications developer, you may find it more beneficial to go directly to the API reference documentation.
If you would like to interact with the models using Cerebras’ Inference solution before making an API call, please visit the developer playground.
This guide will walk you through:
Setting up your developer environment
Installing the Cerebras Inference library
Making your first request to the Cerebras API
​
Prerequisites
To complete this guide, you will need:
A Cerebras account
A Cerebras Inference API key
Python 3.7+ or TypeScript 4.5+
1
Set up your API key

The first thing you will need is a valid API key. Please visit this link and navigate to “API Keys” on the left nav bar.
For security reasons and to avoid configuring your API key each time, it is recommended to set your API key as an environment variable. You can do this by running the following command in your terminal:

macOS / Linux

Windows
export CEREBRAS_API_KEY="your-api-key-here"
2
Install the Cerebras Inference library

The Cerebras Inference library is available for download and installation through the Python Package Index (PyPI) and the npm package manager. To install the library run either of the following commands in your terminal, based on your language of choice:
Note: You can also call the underlying API directly (see cURL request example below in Step 3).

Python

Node.js
pip install --upgrade cerebras_cloud_sdk
3
Making an API request

Once you have configured your API key, you are ready to send your first API request.
The following code snippets demonstrate how to make an API request to the Cerebras API to perform a chat completion.

Python

Node.js

cURL
import os
from cerebras.cloud.sdk import Cerebras

client = Cerebras(
    # This is the default and can be omitted
    api_key=os.environ.get("CEREBRAS_API_KEY"),
)

chat_completion = client.chat.completions.create(
    messages=[
        {
            "role": "user",
            "content": "Why is fast inference important?",
        }
],
    model="gpt-oss-120b",
)

print(chat_completion)

---

Rate Limits
Learn how rate limits are applied and measured.

Rate limits ensure fair usage and system stability by regulating how often users and applications can access our API within a specified timeframe. They help protect our service from abuse or misuse and keep your access fair and without slowdowns.
​
How are rate limits measured?
We measure rate limits in requests sent and tokens used within a specified timeframe:
Requests per minute/hour/day (RPM, RPH, RPD)
Tokens per minute/hour/day (TPM, TPH, TPD)
Rate limiting can be triggered by any metric, whichever comes first. For example, you have a rate limit of 50 RPM and 200K TPM. If you submit 50 requests in one minute with just 100 tokens each, you’ll hit your limit even though your total token usage (5,000) is far below the 200K token threshold.
Rate limits apply at the organization level, not the user level, and vary based on the model.
​
Token Rate Limiting
When you send a request, we estimate the total tokens that will be consumed by:
Estimating the input tokens in your prompt
Adding either the max_completion_tokens parameter or the maximum sequence length (MSL), minus input tokens
If this estimated token consumption would exceed your available token quota, the request is rate limited before processing begins. This ensure fair usage and system stability.
Best practice: Set max_completion_tokens appropriately for your use case to avoid overestimating token usage and triggering unnecessary rate limits.
​
Quota Replenishment
Your quota is calculated as:
Available quota = Rate limit - Usage in current time window
We use the token bucketing algorithm for rate limiting, which means your capacity replenishes continuously rather than resetting at fixed intervals. As you consume tokens or requests, your available capacity automatically refills up to your maximum limit.
This token bucketing approach ensures smoother API access and prevents the “burst at interval start, then idle” pattern.
​
Limits by Tier
This provides an overview of general limits, though specific cases may vary. For precise, up-to-date rate limit information applicable to your organization, check the Limits section within your account.
Free
Pay as You Go
Model	TPM	TPH	TPD	RPM	RPH	RPD
gpt-oss-120b	64K	1M	1M	30	900	14.4K
llama3.1-8b	60K	1M	1M	30	900	14.4K
qwen-3-235b-a22b-instruct-2507	60K	1M	1M	30	900	14.4K
zai-glm-4.7	60K	1M	1M	10	100	100
​
Rate Limit Headers
To help you monitor your usage in real time, we inject several custom headers into every API response. These headers provide insight into your current usage and when your limits will reset.
You’ll find the following headers in the response:
Header	Description
x-ratelimit-limit-requests-day	Maximum number of requests allowed per day.
x-ratelimit-limit-tokens-minute	Maximum number of tokens allowed per minute.
x-ratelimit-remaining-requests-day	Number of requests remaining for the current day.
x-ratelimit-remaining-tokens-minute	Number of tokens remaining for the current minute.
x-ratelimit-reset-requests-day	Time (in seconds) until your daily request limit resets.
x-ratelimit-reset-tokens-minute	Time (in seconds) until your per-minute token limit resets.
These values update with each API call, giving you immediate visibility into your current usage.
​
Example
You can view these headers by adding the --verbose flag to a cURL request:
curl --location 'https://api.cerebras.ai/v1/chat/completions' \
--header 'Content-Type: application/json' \
--header "Authorization: Bearer ${CEREBRAS_API_KEY}" \
--data '{
  "model": "llama3.1-8b",
  "stream": false,
  "messages": [{"content": "Hello!", "role": "user"}],
  "temperature": 0,
  "max_completion_tokens": -1,
  "seed": 0,
  "top_p": 1
}' \
--verbose
In the response, look for headers like these:
x-ratelimit-limit-requests-day: 1000000000
x-ratelimit-limit-tokens-minute: 1000000000
x-ratelimit-remaining-requests-day: 999997455
x-ratelimit-remaining-tokens-minute: 999998298
x-ratelimit-reset-requests-day: 33011.382867097855
x-ratelimit-reset-tokens-minute: 11.382867097854614