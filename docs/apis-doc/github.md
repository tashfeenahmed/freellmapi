# Quickstart for GitHub Models

Run your first model with GitHub Models in minutes.

## Introduction

GitHub Models is an AI inference API from GitHub that lets you run AI models using just your GitHub credentials. You can choose from many different models—including from OpenAI, Meta, and DeepSeek—and use them in scripts, apps, or even GitHub Actions, with no separate authentication process.

This guide helps you try out models quickly in the playground, then shows you how to run your first model via API or workflow.

## Step 1: Try models in the playground

1. Go to **<https://github.com/marketplace/models>**.
2. In the playground, select at least one model from the dropdown menu.
3. Test out different prompts using the **Chat** view, and compare responses from different models.
4. Use the **Parameters** view to customize the parameters for the models you are testing, then see how they impact responses.

   > \[!NOTE]
   > The playground works out of the box if you're signed in to GitHub. It uses your GitHub account for access—no setup or API keys required.

## Step 2: Make an API call

For full details on available fields, headers, and request formats, see the [API reference for GitHub Models](/en/rest/models/inference?apiVersion=2022-11-28).

To call models programmatically, you’ll need:

* A GitHub account.
* A personal access token (PAT) with the `models` scope, which you can create [in settings](https://github.com/settings/tokens).

1. Run the following `curl` command, replacing `YOUR_GITHUB_PAT` with your token.

   ```bash copy
     curl -L \
     -X POST \
     -H "Accept: application/vnd.github+json" \
     -H "Authorization: Bearer YOUR_GITHUB_PAT" \
     -H "X-GitHub-Api-Version: 2022-11-28" \
     -H "Content-Type: application/json" \
     https://models.github.ai/inference/chat/completions \
     -d '{"model":"openai/gpt-4.1","messages":[{"role":"user","content":"What is the capital of France?"}]}'
   ```

2. You’ll receive a response like this:

   ```json
   {
     "choices": [
       {
         "message": {
           "role": "assistant",
           "content": "The capital of France is **Paris**."
         }
       }
     ],
     ...other fields omitted
   }
   ```

3. To try other models, change the value of the `model` field in the JSON payload to one from the [marketplace](https://github.com/marketplace/models).

## Step 3: Run models in GitHub Actions

1. In your repository, create a workflow file at `.github/workflows/models-demo.yml`.

2. Paste the following workflow into the file you just created.

   ```yaml copy
   name: Use GitHub Models

   on: [push]

   permissions:
     models: read

   jobs:
     call-model:
       runs-on: ubuntu-latest
       steps:
         - name: Call AI model
           env:
             GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
           run: |
             curl "https://models.github.ai/inference/chat/completions" \
                -H "Content-Type: application/json" \
                -H "Authorization: Bearer $GITHUB_TOKEN" \
                -d '{
                 "messages": [
                     {
                        "role": "user",
                        "content": "Explain the concept of recursion."
                     }
                  ],
                  "model": "openai/gpt-4o"
               }'
   ```

   > \[!NOTE]
   > Workflows that call GitHub Models must include `models: read` in the permissions block. GitHub-hosted runners provide a `GITHUB_TOKEN` automatically.

3. Commit and push to trigger the workflow.

This example shows how to send a prompt to a model and use the response in your continuous integration (CI) workflows. For more advanced use cases, such as summarizing issues, detecting missing reproduction steps for bug reports, or responding to pull requests, see [Configuring access to AI models in GitHub Copilot](/en/github-models/use-github-models/integrating-ai-models-into-your-development-workflow).

## Step 4: Save your first prompt file

GitHub Models supports reusable prompts defined in `.prompt.yml` files. Once you add this file to your repository, it will appear in the Models page of your repository and can be run directly in the Prompt Editor and evaluation tooling. Learn more about [Storing prompts in GitHub repositories](/en/github-models/use-github-models/storing-prompts-in-github-repositories).

1. In your repository, create a file named `summarize.prompt.yml`. You can save it in any directory.

2. Paste the following example prompt into the file you just created.

   ```yaml copy
   name: Text Summarizer
   description: Summarizes input text concisely
   model: openai/gpt-4o-mini
   modelParameters:
     temperature: 0.5
   messages:
     - role: system
       content: You are a text summarizer. Your only job is to summarize text given to you.
     - role: user
       content: |
         Summarize the given text, beginning with "Summary -":
         <text>
         {{input}}
         </text>
   ```

3. Commit and push the file to your repository.

4. Go to the **Models** tab in your repository.

5. In the navigation menu, click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-note" aria-label="none" role="img"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5Z"></path></svg> Prompts**, then click on the prompt file.

6. The prompt will open in the prompt editor. Click **Run**. A right-hand sidebar will appear asking you to enter input text. Enter any input text, then click **Run** again in the bottom right corner to test it out.

   > \[!NOTE]
   > The prompt editor doesn’t automatically pass repository content into prompts. You provide the input manually.

## Step 5: Set up your first evaluation

Evaluations help you measure how different models respond to the same inputs so you can choose the best one for your use case.

1. Go back to the `summarize.prompt.yml` file you created in the previous step.

2. Update the file to match the following example.

   ```yaml copy
   name: Text Summarizer
   description: Summarizes input text concisely
   model: openai/gpt-4o-mini
   modelParameters:
     temperature: 0.5
   messages:
     - role: system
       content: You are a text summarizer. Your only job is to summarize text given to you.
     - role: user
       content: |
         Summarize the given text, beginning with "Summary -":
         <text>
         {{input}}
         </text>
   testData:
     - input: |
         The quick brown fox jumped over the lazy dog.
         The dog was too tired to react.
       expected: Summary - A fox jumped over a lazy, unresponsive dog.
     - input: |
         The museum opened a new dinosaur exhibit this weekend. Families from all
         over the city came to see the life-sized fossils and interactive displays.
       expected: Summary - The museum's new dinosaur exhibit attracted many families with its fossils and interactive displays.
   evaluators:
     - name: Output should start with 'Summary -'
       string:
         startsWith: 'Summary -'
     - name: Similarity
       uses: github/similarity
   ```

3. Commit and push the file to your repository.

4. In your repository, click the **Models** tab. Then click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-note" aria-label="none" role="img"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5Z"></path></svg> Prompts** and reopen the same prompt in the prompt editor.

5. In the top left-hand corner, you can toggle the view from **Edit** to **Compare**. Click **Compare**.

6. Your evaluation will be set up automatically. Click **Run** to see results.

   > \[!TIP]
   > By clicking **Add prompt**, you can run the same prompt with different models or change the prompt wording to get inference responses with multiple variations at once, see evaluations, and view them side by side to make data-driven model decisions.

## Next steps

* [About GitHub Models](/en/github-models/about-github-models).
* [Browse the model catalog](https://github.com/marketplace?type=models)
* [Storing prompts in GitHub repositories](/en/github-models/use-github-models/storing-prompts-in-github-repositories)
* [Evaluating AI models](/en/github-models/use-github-models/evaluating-ai-models)
* [Configuring access to AI models in GitHub Copilot](/en/github-models/use-github-models/integrating-ai-models-into-your-development-workflow#using-ai-models-with-github-actions)

---

# Prototyping with AI models

Find and experiment with AI models for free.

If you want to develop a generative AI application, you can use GitHub Models to find and experiment with AI models for free. Once you are ready to bring your application to production, [opt in to paid usage](/en/billing/managing-billing-for-your-products/about-billing-for-github-models) for your enterprise.

Organization owners can integrate their preferred custom models into GitHub Models, by using an organization's own LLM API keys. See [Using your own API keys in GitHub Models](/en/github-models/github-models-at-scale/set-up-custom-model-integration-models-byok).

See also [Responsible use of GitHub Models](/en/github-models/responsible-use-of-github-models).

## Finding AI models

To find an AI model:

1. Go to [github.com/marketplace/models](https://github.com/marketplace/models).
2. Click **Model: Select a Model** at the top left of the page.
3. Choose a model from the dropdown menu.

   Alternatively, in the dropdown menu, click **View all models**, click a model in the Marketplace, then click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-command-palette" aria-label="command-palette" role="img"><path d="m6.354 8.04-4.773 4.773a.75.75 0 1 0 1.061 1.06L7.945 8.57a.75.75 0 0 0 0-1.06L2.642 2.206a.75.75 0 0 0-1.06 1.061L6.353 8.04ZM8.75 11.5a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5h-5.5Z"></path></svg> Playground**.

The model is opened in the model playground. Details of the model are displayed in the sidebar on the right. If the sidebar is not displayed, expand it by clicking the **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-sidebar-expand" aria-label="Show parameters setting" role="img"><path d="m4.177 7.823 2.396-2.396A.25.25 0 0 1 7 5.604v4.792a.25.25 0 0 1-.427.177L4.177 8.177a.25.25 0 0 1 0-.354Z"></path><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25H9.5v-13Zm12.5 13a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H11v13Z"></path></svg>** icon at the right of the playground.

> \[!NOTE] Access to OpenAI's models is in public preview and subject to change.

## Experimenting with AI models in the playground

The AI model playground is a free resource that allows you to adjust model parameters and submit prompts to see how a model responds.

> \[!NOTE]
>
> * The model playground is in public preview and subject to change.
> * The playground is rate limited. See [Rate limits](#rate-limits) below.

To adjust parameters for the model, in the playground, select the **Parameters** tab in the sidebar.

To see code that corresponds to the parameters that you selected, switch from the **Chat** tab to the **Code** tab.

![Screenshot of the 'Code' tab button, highlighted with a dark orange outline, at the top left of the playground.](/assets/images/help/models/model-playground-code-tab.png)

### Comparing models

You can submit a prompt to two models at the same time and compare the responses.

With one model open in the playground, click **Compare**, then, in the dropdown menu, select a model for comparison. The selected model opens in a second chat window. When you type a prompt in either chat window, the prompt is mirrored to the other window. The prompts are submitted simultaneously so that you can compare the responses from each model.

Any parameters you set are used for both models.

## Evaluating AI models

Once you've started testing prompts in the playground, you can evaluate model performance using structured metrics. Evaluations help you compare multiple prompt configurations across different models and determine which setup performs best.

In the Comparisons view, you can apply evaluators like similarity, relevance, and groundedness to measure how well each output meets your expectations. You can also define your own evaluation criteria with a custom prompt evaluator.

For step-by-step instructions, see [Evaluating outputs](/en/github-models/use-github-models/evaluating-ai-models#evaluating-outputs).

## Experimenting with AI models using the API

> \[!NOTE]
>
> The free API usage is in public preview and subject to change.

GitHub provides free API usage so that you can experiment with AI models in your own application.

The steps to use each model are similar. In general, you will need to:

1. Go to [github.com/marketplace/models](https://github.com/marketplace/models).

2. Click **Model: Select a Model** at the top left of the page.

3. Choose a model from the dropdown menu.

   Alternatively, in the dropdown menu, click **View all models**, click a model in the Marketplace, then click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-command-palette" aria-label="command-palette" role="img"><path d="m6.354 8.04-4.773 4.773a.75.75 0 1 0 1.061 1.06L7.945 8.57a.75.75 0 0 0 0-1.06L2.642 2.206a.75.75 0 0 0-1.06 1.061L6.353 8.04ZM8.75 11.5a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5h-5.5Z"></path></svg> Playground**.

   The model opens in the model playground.

4. Click the **Code** tab.

5. Optionally, use the language dropdown to select the programming language.

6. Optionally, use the SDK dropdown to select which SDK to use.

   All models can be used with the Azure AI Inference SDK, and some models support additional SDKs. If you want to easily switch between models, you should select "Azure AI Inference SDK." If you selected "REST" as the language, you won't use an SDK. Instead, you will use the API endpoint directly.  See [GitHub Models REST API](/en/rest/models?apiVersion=2022-11-28).

7. Either open a codespace, or set up your local environment:
   * To run in a codespace, click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-codespaces" aria-label="codespaces" role="img"><path d="M0 11.25c0-.966.784-1.75 1.75-1.75h12.5c.966 0 1.75.784 1.75 1.75v3A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm2-9.5C2 .784 2.784 0 3.75 0h8.5C13.216 0 14 .784 14 1.75v5a1.75 1.75 0 0 1-1.75 1.75h-8.5A1.75 1.75 0 0 1 2 6.75Zm1.75-.25a.25.25 0 0 0-.25.25v5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5a.25.25 0 0 0-.25-.25Zm-2 9.5a.25.25 0 0 0-.25.25v3c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-3a.25.25 0 0 0-.25-.25Z"></path><path d="M7 12.75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Zm-4 0a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75Z"></path></svg> Run codespace**, then click **Create new codespace**.
   * To run locally:
     * Create a GitHub personal access token. The token needs to have `models:read` permissions. See [Managing your personal access tokens](/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
     * Save your token as an environment variable.
     * Install the dependencies for the SDK, if required.

8. Use the example code to make a request to the model.

The free API usage is rate limited. See [Rate limits](#rate-limits) below.

## Saving and sharing your playground experiments

You can save and share your progress in the playground with presets. Presets save:

* Your current state
* Your parameters
* Your chat history (optional)

To create a preset for your current context, select **Preset: PRESET-NAME** <svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-triangle-down" aria-label="triangle-down" role="img"><path d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"></path></svg> at the top right of the playground, then click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-plus" aria-label="plus" role="img"><path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"></path></svg> Create new preset**. You need to name your preset, and you can also choose to provide a preset description, include your chat history, and allow your preset to be shared.

There are two ways to load a preset:

* Select the **Preset: PRESET-NAME** <svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-triangle-down" aria-label="triangle-down" role="img"><path d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"></path></svg> dropdown menu, then click the preset you want to load.
* Open a shared preset URL

After you load a preset, you can edit, share, or delete the preset:

* To edit the preset, change the parameters and prompt the model. Once you are satisfied with your changes, select the **Preset: PRESET-NAME** <svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-triangle-down" aria-label="triangle-down" role="img"><path d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"></path></svg> dropdown menu, then click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-pencil" aria-label="pencil" role="img"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"></path></svg> Edit preset** and save your updates.
* To share the preset, select the **Preset: PRESET-NAME** <svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-triangle-down" aria-label="triangle-down" role="img"><path d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"></path></svg> dropdown menu, then click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-share" aria-label="share" role="img"><path d="M3.75 6.5a.25.25 0 0 0-.25.25v6.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25h-1a.75.75 0 0 1 0-1.5h1c.966 0 1.75.784 1.75 1.75v6.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-6.5C2 5.784 2.784 5 3.75 5h1a.75.75 0 0 1 0 1.5ZM7.823.177a.25.25 0 0 1 .354 0l2.896 2.896a.25.25 0 0 1-.177.427H8.75v5.75a.75.75 0 0 1-1.5 0V3.5H5.104a.25.25 0 0 1-.177-.427Z"></path></svg> Share preset** to get a shareable URL.
* To delete the preset, select the **Preset: PRESET-NAME** <svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-triangle-down" aria-label="triangle-down" role="img"><path d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"></path></svg> dropdown menu, then click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-trash" aria-label="trash" role="img"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"></path></svg> Delete preset** and confirm the deletion.

## Using the prompt editor

The prompt editor in GitHub Models is designed to help you iterate, refine, and perfect your prompts. This dedicated view provides a focused and intuitive experience for crafting and testing inputs, enabling you to:

* Quickly test and refine prompts without the complexity of multi-turn interactions.
* Fine-tune prompts for precision and relevance in your projects.
* Use a specialized space for single-turn scenarios to ensure consistent and optimized results.

To access the prompt editor, click **<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-stack" aria-label="stack" role="img"><path d="M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.251 1.251 0 0 1 0-2.162ZM8.125 1.69a.248.248 0 0 0-.25 0l-4.63 2.685 4.63 2.685a.248.248 0 0 0 .25 0l4.63-2.685ZM1.601 7.789a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0L1.874 8.814A.75.75 0 0 1 1.6 7.789Zm0 3.5a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0l-5.248-3.044a.75.75 0 0 1-.273-1.025Z"></path></svg> Prompt editor** at the top right of the playground.

![Screenshot of the 'Prompt editor' button, highlighted with a dark orange outline, at the top right of the playground.](/assets/images/help/models/model-playground-prompt-editor.png)

## Experimenting with AI models in Visual Studio Code

> \[!NOTE] The AI Toolkit extension for Visual Studio Code is in public preview and is subject to change.

If you prefer to experiment with AI models in your IDE, you can install the AI Toolkit extension for Visual Studio Code, then test models with adjustable parameters and context.

1. In Visual Studio Code, install the pre-release version of the [AI Toolkit for Visual Studio Code](https://marketplace.visualstudio.com/items?itemName=ms-windows-ai-studio.windows-ai-studio).

2. To open the extension, click the AI Toolkit icon in the activity bar.

3. Authorize the AI Toolkit to connect to your GitHub account.

4. In the "My models" section of the AI Toolkit panel, click **Open Model Catalog**, then find a model to experiment with.
   * To use a model hosted remotely through GitHub Models, on the model card, click **Try in playground**.
   * To download and use a model locally, on the model card, click **Download**. Once the download is complete, on the same model card, click **Load in playground**.

5. In the sidebar, provide any context instructions and inference parameters for the model, then send a prompt.

## Going to production

The free rate limits provided in the playground and API usage are intended to help you get started with experimentation. When you are ready to move beyond the free offering, you have two options for accessing AI models beyond the free limits:

* You can opt in to paid usage for GitHub Models, allowing your organization to access increased rate limits, larger context windows, and additional features. See [GitHub Models billing](/en/billing/managing-billing-for-your-products/about-billing-for-github-models).
* If you have an existing OpenAI or Azure subscription, you can bring your own API keys (BYOK) to access custom models. Billing and usage are managed directly through your provider account, such as your Azure Subscription ID. See [Using your own API keys in GitHub Models](/en/github-models/github-models-at-scale/set-up-custom-model-integration-models-byok).

## Rate limits

> \[!NOTE] Once you opt in to paid usage, you will have access to production grade rate limits and be billed for all usage thereafter. For more information about these rate limits, see [Microsoft Foundry Models quotas and limits](https://learn.microsoft.com/en-us/azure/ai-foundry/model-inference/quotas-limits) in the Azure documentation.

The playground and free API usage are rate limited by requests per minute, requests per day, tokens per request, and concurrent requests. If you get rate limited, you will need to wait for the rate limit that you hit to reset before you can make more requests.

Low, high, and embedding models have different rate limits. To see which type of model you are using, refer to the model's information in GitHub Marketplace.

For custom models accessed with your own API keys, rate limits are set and enforced by your model provider.

<table>
  <tr>
    <th scope="col" style="width:15%"><b>Rate limit tier</b></th>
    <th scope="col" style="width:25%"><b>Rate limits</b></th>
    <th scope="col" style="width:15%"><b>Copilot Free</b></th>
    <th scope="col" style="width:15%"><b>Copilot Pro</b></th>
    <th scope="col" style="width:15%"><b>Copilot Business</b></th>
    <th scope="col" style="width:15%"><b>Copilot Enterprise</b></th>
  </tr>
  <tr>
    <th rowspan="4" scope="rowgroup"><b>Low</b></th>
    <th style="padding-left: 0"><b>Requests per minute</b></th>
    <td>15</td>
    <td>15</td>
    <td>15</td>
    <td>20</td>
  </tr>
  <tr>
    <th><b>Requests per day</b></th>
    <td>150</td>
    <td>150</td>
    <td>300</td>
    <td>450</td>
  </tr>
  <tr>
    <th><b>Tokens per request</b></th>
    <td>8000 in, 4000 out</td>
    <td>8000 in, 4000 out</td>
    <td>8000 in, 4000 out</td>
    <td>8000 in, 8000 out</td>
  </tr>
  <tr>
    <th><b>Concurrent requests</b></th>
    <td>5</td>
    <td>5</td>
    <td>5</td>
    <td>8</td>
  </tr>
  <tr>
    <th rowspan="4" scope="rowgroup"><b>High</b></th>
    <th style="padding-left: 0"><b>Requests per minute</b></th>
    <td>10</td>
    <td>10</td>
    <td>10</td>
    <td>15</td>
  </tr>
  <tr>
    <th><b>Requests per day</b></th>
    <td>50</td>
    <td>50</td>
    <td>100</td>
    <td>150</td>
  </tr>
  <tr>
    <th><b>Tokens per request</b></th>
    <td>8000 in, 4000 out</td>
    <td>8000 in, 4000 out</td>
    <td>8000 in, 4000 out</td>
    <td>16000 in, 8000 out</td>
  </tr>
  <tr>
    <th><b>Concurrent requests</b></th>
    <td>2</td>
    <td>2</td>
    <td>2</td>
    <td>4</td>
  </tr>
  <tr>
    <th rowspan="4" scope="rowgroup"><b>Embedding</b></th>
    <th style="padding-left: 0"><b>Requests per minute</b></th>
    <td>15</td>
    <td>15</td>
    <td>15</td>
    <td>20</td>
  </tr>
  <tr>
    <th><b>Requests per day</b></th>
    <td>150</td>
    <td>150</td>
    <td>300</td>
    <td>450</td>
  </tr>
  <tr>
    <th><b>Tokens per request</b></th>
    <td>64000</td>
    <td>64000</td>
    <td>64000</td>
    <td>64000</td>
  </tr>
  <tr>
    <th><b>Concurrent requests</b></th>
    <td>5</td>
    <td>5</td>
    <td>5</td>
    <td>8</td>
  </tr>
  <tr>
    <th rowspan="4" scope="rowgroup"><b>Azure OpenAI o1-preview</b></th>
    <th style="padding-left: 0"><b>Requests per minute</b></th>
    <td>Not applicable</td>
    <td>1</td>
    <td>2</td>
    <td>2</td>
  </tr>
  <tr>
    <th><b>Requests per day</b></th>
    <td>Not applicable</td>
    <td>8</td>
    <td>10</td>
    <td>12</td>
  </tr>
  <tr>
    <th><b>Tokens per request</b></th>
    <td>Not applicable</td>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 8000 out</td>
  </tr>
  <tr>
    <th><b>Concurrent requests</b></th>
    <td>Not applicable</td>
    <td>1</td>
    <td>1</td>
    <td>1</td>
  </tr>
  <tr>
    <th rowspan="4" scope="rowgroup"><b>Azure OpenAI o1, o3, and gpt-5</b></th>
    <th style="padding-left: 0"><b>Requests per minute</b></th>
    <td>Not applicable</td>
    <td>1</td>
    <td>2</td>
    <td>2</td>
  </tr>
  <tr>
    <th><b>Requests per day</b></th>
    <td>Not applicable</td>
    <td>8</td>
    <td>10</td>
    <td>12</td>
  </tr>
  <tr>
    <th><b>Tokens per request</b></th>
    <td>Not applicable</td>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 8000 out</td>
  </tr>
  <tr>
    <th><b>Concurrent requests</b></th>
    <td>Not applicable</td>
    <td>1</td>
    <td>1</td>
    <td>1</td>
  </tr>
  <tr>
    <th rowspan="4" scope="rowgroup"><b>Azure OpenAI o1-mini, o3-mini, o4-mini, gpt-5-mini, gpt-5-nano, and gpt-5-chat</b></th>
    <th style="padding-left: 0"><b>Requests per minute</b></th>
    <td>Not applicable</td>
    <td>2</td>
    <td>3</td>
    <td>3</td>
  </tr>
  <tr>
    <th><b>Requests per day</b></th>
    <td>Not applicable</td>
    <td>12</td>
    <td>15</td>
    <td>20</td>
  </tr>
  <tr>
    <th><b>Tokens per request</b></th>
    <td>Not applicable</td>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 4000 out</td>
  </tr>
  <tr>
    <th><b>Concurrent requests</b></th>
    <td>Not applicable</td>
    <td>1</td>
    <td>1</td>
    <td>1</td>
  </tr>
  <tr>
    <th rowspan="4" scope="rowgroup"><b>DeepSeek-R1, DeepSeek-R1-0528, and MAI-DS-R1</b></th>
    <th style="padding-left: 0"><b>Requests per minute</b></th>
    <td>1</td>
    <td>1</td>
    <td>2</td>
    <td>2</td>
  </tr>
  <tr>
    <th><b>Requests per day</b></th>
    <td>8</td>
    <td>8</td>
    <td>10</td>
    <td>12</td>
  </tr>
  <tr>
    <th><b>Tokens per request</b></th>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 4000 out</td>
  </tr>
  <tr>
    <th><b>Concurrent requests</b></th>
    <td>1</td>
    <td>1</td>
    <td>1</td>
    <td>1</td>
  </tr>
  <tr>
    <th rowspan="4" scope="rowgroup"><b>xAI Grok-3</b></th>
    <th style="padding-left: 0"><b>Requests per minute</b></th>
    <td>1</td>
    <td>1</td>
    <td>2</td>
    <td>2</td>
  </tr>
  <tr>
    <th><b>Requests per day</b></th>
    <td>15</td>
    <td>15</td>
    <td>20</td>
    <td>30</td>
  </tr>
  <tr>
    <th><b>Tokens per request</b></th>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 4000 out</td>
    <td>4000 in, 8000 out</td>
    <td>4000 in, 16000 out</td>
  </tr>
  <tr>
    <th><b>Concurrent requests</b></th>
    <td>1</td>
    <td>1</td>
    <td>1</td>
    <td>1</td>
  </tr>
  <tr>
    <th rowspan="4" scope="rowgroup" style="box-shadow: none"><b>xAI Grok-3-Mini</b></th>
    <th style="padding-left: 0"><b>Requests per minute</b></th>
    <td>2</td>
    <td>2</td>
    <td>3</td>
    <td>3</td>
  </tr>
  <tr>
    <th><b>Requests per day</b></th>
    <td>30</td>
    <td>30</td>
    <td>40</td>
    <td>50</td>
  </tr>
  <tr>
    <th><b>Tokens per request</b></th>
    <td>4000 in, 8000 out</td>
    <td>4000 in, 8000 out</td>
    <td>4000 in, 12000 out</td>
    <td>4000 in, 12000 out</td>
  </tr>
  <tr>
    <th><b>Concurrent requests</b></th>
    <td>1</td>
    <td>1</td>
    <td>1</td>
    <td>1</td>
  </tr>
</table>

These limits are subject to change without notice.

## Leaving feedback

To ask questions and share feedback, see this [GitHub Models discussion post](https://github.com/orgs/community/discussions/159087).
To learn how others are using GitHub Models, visit the [GitHub Community discussions for Models](https://github.com/orgs/community/discussions/categories/models).