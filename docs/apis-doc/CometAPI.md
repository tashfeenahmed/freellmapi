> ## Documentation Index
> Fetch the complete documentation index at: https://apidoc.cometapi.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Quick Start

> Quick Start for CometAPI: get your API key, switch the base URL, and start calling chat completions and other models in minutes with Apidog.

## First time using CometAPI?

You can watch the video “[How to Use CometAPI](https://www.youtube.com/watch?v=dub1FSy_jTk)” to quickly learn how to request CometAPI through Apidog.

***

## Integration requires only three steps:

### **Step 1. Get your API key**

1. Top up your account on the [CometAPI dashboard](https://www.cometapi.com/console).
2. To create a new API key, go to the [Token page](https://www.cometapi.com/console/token) and click **Add Token**.

***

### **Step 2. Replace the base URL**

1. Modify the **BASE\_URL** in your application to our interface address, for example:\
   Replace OpenAI's Base URL with `https://api.cometapi.com`.

2. Different clients may need to try the following addresses:
   * `https://api.cometapi.com`
   * `https://api.cometapi.com/v1`
   * `https://api.cometapi.com/v1/chat/completions`

***

### **Step 3. Replace the API key**

1. Replace the API key in your client with the key from CometAPI.
2. After replacement, you can start making requests.

***

## **Ongoing support**

If you encounter any issues during integration, contact our support team.

* Support: [https://www.cometapi.com/support/](https://www.cometapi.com/support/)
* Dashboard: [https://www.cometapi.com/console](https://www.cometapi.com/console)

For further calling instructions and development guides, refer to the [API documentation](/overview/quick-start).

> ## Documentation Index
> Fetch the complete documentation index at: https://apidoc.cometapi.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Important Guidelines

> Key CometAPI guidelines: claim free credit, top up via Stripe, generate tokens, switch models, pick base URLs, and track usage logs and billing.

# CometAPI getting started guide

## How to claim the \$0.1 USD credit?

No special operation required. After registering and logging in, you can see the \$0.1 USD credit in your **Wallet page**.

***

## How to top up?

1. After logging in, enter the amount you wish to add on the **Wallet page**, minimum \$10 USD.
2. Use **stripe**  to complete the payment.

***

## Which large language model APIs are available?

Current model availability and pricing are listed in the [model page](https://www.cometapi.com/models). Use the [Models page](/overview/models) when you need current model IDs for requests.

***

## How to get an API key?

1. After registering and logging into CometAPI, go to the **"Tokens"** menu on the left, and click **"Add Token"**.
2. Enter a custom name to generate your API key.
   * This API key can be used for GPT, Claude, Gemini, and all other supported models.

***

## How to switch between models?

Change the **`model` parameter** in your code to switch models.
Note that you need to enter the complete model ID. For specific usage methods, refer to the [API documentation](/overview/quick-start).

***

***

## Is billing per usage or monthly?

1. **Pay-as-you-go**: Consistent with official pricing, calculated based on Token consumption. You pay only for what you use.
   * No monthly subscription required, balance never expires, and unused portions are refundable.
2. **Special model billing**: Models like MidJourney, Suno, Luma (image, music, video models) are billed per usage.

***

## Why are there 3 base URLs? Which one should I use?

Different development environments or software handle Base URLs differently.
Try these 3 addresses:

* `https://api.cometapi.com/v1/`
* `https://api.cometapi.com/v1/chat/completions/`
* `https://api.cometapi.com/`

If you encounter a **404 error**, please check if your Base URL setting is correct.

***

## Does CometAPI support the latest Claude models?

Yes. CometAPI supports the full range of Claude models, including:

* Sonnet
* Haiku
* Opus series

***

## Which URL should I use for Anthropic Claude?

The Base URL is **the same** for all models:

* Including OpenAI, Claude series, Google Gemini, and other models.

***

## How to check how many Tokens were consumed in a call?

1. Go to the **"Logs" page**.
2. Click on a single log entry to expand detailed call information and view the calculation formula and Token consumption:
   * **Prompt**: Understood as the user input.
   * **Completion**: Understood as the AI's response.

***

## What do "prompt" and "completion" refer to?

* **Prompt**: Refers to the content input by the user.
* **Completion**: Refers to the content output by the AI.

***

## What happens if my balance becomes negative?

When your balance is very low, if the cost of your last call exceeds your remaining balance, your balance will show as negative.
Please top up promptly to continue using the service.

> ## Documentation Index
> Fetch the complete documentation index at: https://apidoc.cometapi.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Hermes Agent

> Connect Hermes Agent to CometAPI: install the CLI, store your key in ~/.hermes/.env, point config.yaml to CometAPI, and verify the connection with a real chat.

Use [CometAPI](https://www.cometapi.com) as the model provider for [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) through Hermes's custom OpenAI-compatible endpoint support.

## Prerequisites

* Git
* A CometAPI account with an active API key
* A terminal on macOS, Linux, or WSL2

## Installation

<Steps>
  <Step title="Get your CometAPI API key">
    Log in to the [CometAPI console](https://www.cometapi.com/console/token). Click **Add API Key** and copy your `<COMETAPI_KEY>` key.

    <Frame>
      <img src="https://mintcdn.com/cometapi/SZhlxZhCnMLn__BW/images/overview/810968_364191.png?fit=max&auto=format&n=SZhlxZhCnMLn__BW&q=85&s=aef81a83f29f8eb16655ed4060425f50" alt="CometAPI dashboard showing the Add API Key button" width="3824" height="1892" data-path="images/overview/810968_364191.png" />
    </Frame>

    <Frame>
      <img src="https://mintcdn.com/cometapi/HhtmQffktazbxUvS/images/overview/810968_364193.png?fit=max&auto=format&n=HhtmQffktazbxUvS&q=85&s=d893f659267150d0faf45f99eb5dffc1" alt="CometAPI API key details with the base URL shown" width="2434" height="1232" data-path="images/overview/810968_364193.png" />
    </Frame>
  </Step>

  <Step title="Install Hermes Agent">
    The following command runs the official installer:

    ```bash theme={null}
    curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
    ```

    If the current shell does not see the `hermes` command yet, reload the shell configuration:

    ```bash theme={null}
    source ~/.zshrc
    # or
    source ~/.bashrc
    ```

    <Note>
      Hermes stores config in `~/.hermes/`, links the `hermes` command in `~/.local/bin`, and may add `~/.local/bin` to your shell PATH.
    </Note>
  </Step>
</Steps>

## Configuration

<Steps>
  <Step title="Store your CometAPI key">
    Open `~/.hermes/.env` and add the following line:

    ```bash theme={null}
    OPENAI_API_KEY=<COMETAPI_KEY>
    ```

    Hermes uses `OPENAI_API_KEY` as the auth fallback for custom OpenAI-compatible endpoints.
  </Step>

  <Step title="Configure the CometAPI endpoint">
    Open `~/.hermes/config.yaml` and make sure the `model` section looks like this:

    ```yaml theme={null}
    model:
      provider: custom
      default: your-model-id
      base_url: https://api.cometapi.com/v1
    ```

    Replace `your-model-id` with a current text model ID from the [CometAPI Models page](https://www.cometapi.com/models/).

    <Note>
      Keep the API key in `~/.hermes/.env`. Do not hardcode secrets in `config.yaml`.
    </Note>

    <Note>
      This setup configures the main chat model. Hermes can use separate auxiliary models for tasks such as vision or web extraction.
    </Note>
  </Step>
</Steps>

## Verification

<Steps>
  <Step title="Check the configuration">
    The following commands confirm that Hermes can read the config and the API key:

    ```bash theme={null}
    hermes config check
    hermes doctor
    hermes status
    ```

    If `hermes config check` reports missing options after an update, run `hermes config migrate` and check again.
  </Step>

  <Step title="Run a real chat test">
    The following command sends a real request through CometAPI:

    ```bash theme={null}
    hermes chat -q "Reply with the single word CONNECTED."
    ```

    A successful setup returns `CONNECTED` and no auth or endpoint errors.
  </Step>
</Steps>

## Optional configuration

<AccordionGroup>
  <Accordion title="Clean reinstall (optional)">
    If you are replacing an older Hermes install, use the built-in uninstaller first:

    ```bash theme={null}
    hermes uninstall
    ```

    In the uninstaller, choose **Full uninstall** to remove the CLI, PATH entry, and `~/.hermes/` data. Then rerun the install step and continue with the same CometAPI configuration.
  </Accordion>

  <Accordion title="Use hermes model instead (optional)">
    If you prefer the interactive flow, run `hermes model` and choose **Custom endpoint**.

    Then enter the following values:

    * Base URL: `https://api.cometapi.com/v1`
    * API key: your CometAPI API key
    * Model: a current CometAPI text model ID

    This flow writes the same provider settings into `config.yaml`.
  </Accordion>
</AccordionGroup>