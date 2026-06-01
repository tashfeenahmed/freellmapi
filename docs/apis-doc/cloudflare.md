---
title: gpt-oss-120b
description: OpenAI’s open-weight models designed for powerful reasoning, agentic tasks, and versatile developer use cases – gpt-oss-120b is for production, general purpose, high reasoning use-cases.
image: https://developers.cloudflare.com/dev-products-preview.png
---

[Skip to content](#%5Ftop) 

Was this helpful?

YesNo

[ Report issue ](https://github.com/cloudflare/cloudflare-docs/issues/new/choose) 

Copy page

![OpenAI logo](https://developers.cloudflare.com/_astro/openai.BI8PEEzI.svg) 

#  gpt-oss-120b 

Text Generation • OpenAI • Hosted 

`@cf/openai/gpt-oss-120b` 

OpenAI’s open-weight models designed for powerful reasoning, agentic tasks, and versatile developer use cases – gpt-oss-120b is for production, general purpose, high reasoning use-cases.

| Model Info                                                                           |                                                     |
| ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Context Window[ ↗](https://developers.cloudflare.com/workers-ai/glossary/)           | 128,000 tokens                                      |
| Function calling [ ↗](https://developers.cloudflare.com/workers-ai/function-calling) | Yes                                                 |
| Reasoning                                                                            | Yes                                                 |
| Unit Pricing                                                                         | $0.35 per M input tokens, $0.75 per M output tokens |

## Usage

* [  TypeScript ](#tab-panel-542)
* [  Python ](#tab-panel-543)
* [  curl ](#tab-panel-544)

```

export default {

  async fetch(request, env): Promise<Response> {

    const response = await env.AI.run('@cf/openai/gpt-oss-120b', {

      instructions: 'You are a concise assistant.',

      input: 'What is the origin of the phrase Hello, World?',

    });


    return Response.json(response);

  },

} satisfies ExportedHandler<Env>;


```

Explain Code

```

import os

import requests


ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")

AUTH_TOKEN = os.environ.get("CLOUDFLARE_AUTH_TOKEN")


prompt = "Tell me all about PEP-8"

response = requests.post(

  f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/responses",

    headers={"Authorization": f"Bearer {AUTH_TOKEN}"},

    json={

      "model": "@cf/openai/gpt-oss-120b",

      "input": "Tell me all about PEP-8"

    }

)

result = response.json()

print(result)


```

Explain Code

Terminal window

```

curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/v1/responses   -H "Content-Type: application/json"   -H "Authorization: Bearer $CLOUDFLARE_AUTH_TOKEN"   -d '{

    "model": "@cf/openai/gpt-oss-120b",

    "input": "What are the benefits of open-source models?"

  }'


```

Multiple API format support 

This model supports three different API formats:
* **Responses API** (`/ai/v1/responses`) - Native OpenAI responses format shown above with `input` parameter
* **Workers AI Run** (`/ai/run`) - Dynamic format detection, accepts Chat Completions (`messages`), legacy Completions (`prompt`), or Responses API (`input`)
* **Chat Completions** (`/v1/chat/completions`) - OpenAI-compatible endpoint with `messages` array. Refer to [OpenAI Compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)for details.

## Parameters

Synchronous — Send a request and receive a complete response 

* [ Input ](#tab-panel-551)
* [ Output ](#tab-panel-552)

Input format

Prompt

Simple text input for single-turn interactions

Messages

Structured conversation format with roles (user, assistant, system)

prompt

`string`requiredminLength: 1The input text prompt for the model to generate a response.

lora

`string`Name of the LoRA (Low-Rank Adaptation) model to fine-tune the base model.

▶response\_format{}

`object`

raw

`boolean`default: falseIf true, a chat template is not applied and you must adhere to the specific model's expected formatting.

stream

`boolean`default: falseIf true, the response will be streamed back incrementally using SSE, Server Sent Events.

max\_tokens

`integer`default: 256The maximum number of tokens to generate in the response.

temperature

`number`default: 0.6minimum: 0maximum: 5Controls the randomness of the output; higher values produce more random results.

top\_p

`number`minimum: 0.001maximum: 1Adjusts the creativity of the AI's responses by controlling how many possible words it considers. Lower values make outputs more predictable; higher values allow for more varied and creative responses.

top\_k

`integer`minimum: 1maximum: 50Limits the AI to choose from the top 'k' most probable words. Lower values make responses more focused; higher values introduce more variety and potential surprises.

seed

`integer`minimum: 1maximum: 9999999999Random seed for reproducibility of the generation.

repetition\_penalty

`number`minimum: 0maximum: 2Penalty for repeated tokens; higher values discourage repetition.

frequency\_penalty

`number`minimum: \-2maximum: 2Decreases the likelihood of the model repeating the same lines verbatim.

presence\_penalty

`number`minimum: \-2maximum: 2Increases the likelihood of the model introducing new topics.

type

`object`

contentType

`application/json`

Streaming — Send a request with \`stream: true\` and receive server-sent events 

* [ Input ](#tab-panel-553)
* [ Output ](#tab-panel-554)

Input format

Prompt

Simple text input for single-turn interactions

Messages

Structured conversation format with roles (user, assistant, system)

prompt

`string`requiredminLength: 1The input text prompt for the model to generate a response.

lora

`string`Name of the LoRA (Low-Rank Adaptation) model to fine-tune the base model.

▶response\_format{}

`object`

raw

`boolean`default: falseIf true, a chat template is not applied and you must adhere to the specific model's expected formatting.

stream

`boolean`default: falseIf true, the response will be streamed back incrementally using SSE, Server Sent Events.

max\_tokens

`integer`default: 256The maximum number of tokens to generate in the response.

temperature

`number`default: 0.6minimum: 0maximum: 5Controls the randomness of the output; higher values produce more random results.

top\_p

`number`minimum: 0.001maximum: 1Adjusts the creativity of the AI's responses by controlling how many possible words it considers. Lower values make outputs more predictable; higher values allow for more varied and creative responses.

top\_k

`integer`minimum: 1maximum: 50Limits the AI to choose from the top 'k' most probable words. Lower values make responses more focused; higher values introduce more variety and potential surprises.

seed

`integer`minimum: 1maximum: 9999999999Random seed for reproducibility of the generation.

repetition\_penalty

`number`minimum: 0maximum: 2Penalty for repeated tokens; higher values discourage repetition.

frequency\_penalty

`number`minimum: \-2maximum: 2Decreases the likelihood of the model repeating the same lines verbatim.

presence\_penalty

`number`minimum: \-2maximum: 2Increases the likelihood of the model introducing new topics.

type

`string`

contentType

`text/event-stream`

format

`binary`

Batch — Send multiple requests in a single API call 

* [ Input ](#tab-panel-555)
* [ Output ](#tab-panel-556)

▶requests\[\]

`array`required

type

`object`

contentType

`application/json`

## API Schemas (Raw)

Synchronous — Send a request and receive a complete response 

* [ Input ](#tab-panel-547)
* [ Output ](#tab-panel-548)

```

{

  "type": "object",

  "oneOf": [

    {

      "title": "Prompt",

      "properties": {

        "prompt": {

          "type": "string",

          "minLength": 1,

          "description": "The input text prompt for the model to generate a response."

        },

        "lora": {

          "type": "string",

          "description": "Name of the LoRA (Low-Rank Adaptation) model to fine-tune the base model."

        },

        "response_format": {

          "title": "JSON Mode",

          "type": "object",

          "properties": {

            "type": {

              "type": "string",

              "enum": [

                "json_object",

                "json_schema"

              ]

            },

            "json_schema": {}

          }

        },

        "raw": {

          "type": "boolean",

          "default": false,

          "description": "If true, a chat template is not applied and you must adhere to the specific model's expected formatting."

        },

        "stream": {

          "type": "boolean",

          "default": false,

          "description": "If true, the response will be streamed back incrementally using SSE, Server Sent Events."

        },

        "max_tokens": {

          "type": "integer",

          "default": 256,

          "description": "The maximum number of tokens to generate in the response."

        },

        "temperature": {

          "type": "number",

          "default": 0.6,

          "minimum": 0,

          "maximum": 5,

          "description": "Controls the randomness of the output; higher values produce more random results."

        },

        "top_p": {

          "type": "number",

          "minimum": 0.001,

          "maximum": 1,

          "description": "Adjusts the creativity of the AI's responses by controlling how many possible words it considers. Lower values make outputs more predictable; higher values allow for more varied and creative responses."

        },

        "top_k": {

          "type": "integer",

          "minimum": 1,

          "maximum": 50,

          "description": "Limits the AI to choose from the top 'k' most probable words. Lower values make responses more focused; higher values introduce more variety and potential surprises."

        },

        "seed": {

          "type": "integer",

          "minimum": 1,

          "maximum": 9999999999,

          "description": "Random seed for reproducibility of the generation."

        },

        "repetition_penalty": {

          "type": "number",

          "minimum": 0,

          "maximum": 2,

          "description": "Penalty for repeated tokens; higher values discourage repetition."

        },

        "frequency_penalty": {

          "type": "number",

          "minimum": -2,

          "maximum": 2,

          "description": "Decreases the likelihood of the model repeating the same lines verbatim."

        },

        "presence_penalty": {

          "type": "number",

          "minimum": -2,

          "maximum": 2,

          "description": "Increases the likelihood of the model introducing new topics."

        }

      },

      "required": [

        "prompt"

      ]

    },

    {

      "title": "Messages",

      "properties": {

        "messages": {

          "type": "array",

          "description": "An array of message objects representing the conversation history.",

          "items": {

            "type": "object",

            "properties": {

              "role": {

                "type": "string",

                "description": "The role of the message sender (e.g., 'user', 'assistant', 'system', 'tool')."

              },

              "content": {

                "oneOf": [

                  {

                    "type": "string",

                    "description": "The content of the message as a string."

                  },

                  {

                    "type": "array",

                    "description": "Array of text content parts.",

                    "items": {

                      "type": "object",

                      "properties": {

                        "type": {

                          "type": "string",

                          "description": "Type of the content (text)"

                        },

                        "text": {

                          "type": "string",

                          "description": "Text content"

                        }

                      }

                    }

                  }

                ]

              }

            },

            "required": [

              "role",

              "content"

            ]

          }

        },

        "functions": {

          "type": "array",

          "items": {

            "type": "object",

            "properties": {

              "name": {

                "type": "string"

              },

              "code": {

                "type": "string"

              }

            },

            "required": [

              "name",

              "code"

            ]

          }

        },

        "tools": {

          "type": "array",

          "description": "A list of tools available for the assistant to use.",

          "items": {

            "type": "object",

            "oneOf": [

              {

                "properties": {

                  "name": {

                    "type": "string",

                    "description": "The name of the tool. More descriptive the better."

                  },

                  "description": {

                    "type": "string",

                    "description": "A brief description of what the tool does."

                  },

                  "parameters": {

                    "type": "object",

                    "description": "Schema defining the parameters accepted by the tool.",

                    "properties": {

                      "type": {

                        "type": "string",

                        "description": "The type of the parameters object (usually 'object')."

                      },

                      "required": {

                        "type": "array",

                        "description": "List of required parameter names.",

                        "items": {

                          "type": "string"

                        }

                      },

                      "properties": {

                        "type": "object",

                        "description": "Definitions of each parameter.",

                        "additionalProperties": {

                          "type": "object",

                          "properties": {

                            "type": {

                              "type": "string",

                              "description": "The data type of the parameter."

                            },

                            "description": {

                              "type": "string",

                              "description": "A description of the expected parameter."

                            }

                          },

                          "required": [

                            "type",

                            "description"

                          ]

                        }

                      }

                    },

                    "required": [

                      "type",

                      "properties"

                    ]

                  }

                },

                "required": [

                  "name",

                  "description",

                  "parameters"

                ]

              },

              {

                "properties": {

                  "type": {

                    "type": "string",

                    "description": "Specifies the type of tool (e.g., 'function')."

                  },

                  "function": {

                    "type": "object",

                    "description": "Details of the function tool.",

                    "properties": {

                      "name": {

                        "type": "string",

                        "description": "The name of the function."

                      },

                      "description": {

                        "type": "string",

                        "description": "A brief description of what the function does."

                      },

                      "parameters": {

                        "type": "object",

                        "description": "Schema defining the parameters accepted by the function.",

                        "properties": {

                          "type": {

                            "type": "string",

                            "description": "The type of the parameters object (usually 'object')."

                          },

                          "required": {

                            "type": "array",

                            "description": "List of required parameter names.",

                            "items": {

                              "type": "string"

                            }

                          },

                          "properties": {

                            "type": "object",

                            "description": "Definitions of each parameter.",

                            "additionalProperties": {

                              "type": "object",

                              "properties": {

                                "type": {

                                  "type": "string",

                                  "description": "The data type of the parameter."

                                },

                                "description": {

                                  "type": "string",

                                  "description": "A description of the expected parameter."

                                }

                              },

                              "required": [

                                "type",

                                "description"

                              ]

                            }

                          }

                        },

                        "required": [

                          "type",

                          "properties"

                        ]

                      }

                    },

                    "required": [

                      "name",

                      "description",

                      "parameters"

                    ]

                  }

                },

                "required": [

                  "type",

                  "function"

                ]

              }

            ]

          }

        },

        "response_format": {

          "title": "JSON Mode",

          "type": "object",

          "properties": {

            "type": {

              "type": "string",

              "enum": [

                "json_object",

                "json_schema"

              ]

            },

            "json_schema": {}

          }

        },

        "raw": {

          "type": "boolean",

          "default": false,

          "description": "If true, a chat template is not applied and you must adhere to the specific model's expected formatting."

        },

        "stream": {

          "type": "boolean",

          "default": false,

          "description": "If true, the response will be streamed back incrementally using SSE, Server Sent Events."

        },

        "max_tokens": {

          "type": "integer",

          "default": 256,

          "description": "The maximum number of tokens to generate in the response."

        },

        "temperature": {

          "type": "number",

          "default": 0.6,

          "minimum": 0,

          "maximum": 5,

          "description": "Controls the randomness of the output; higher values produce more random results."

        },

        "top_p": {

          "type": "number",

          "minimum": 0.001,

          "maximum": 1,

          "description": "Adjusts the creativity of the AI's responses by controlling how many possible words it considers. Lower values make outputs more predictable; higher values allow for more varied and creative responses."

        },

        "top_k": {

          "type": "integer",

          "minimum": 1,

          "maximum": 50,

          "description": "Limits the AI to choose from the top 'k' most probable words. Lower values make responses more focused; higher values introduce more variety and potential surprises."

        },

        "seed": {

          "type": "integer",

          "minimum": 1,

          "maximum": 9999999999,

          "description": "Random seed for reproducibility of the generation."

        },

        "repetition_penalty": {

          "type": "number",

          "minimum": 0,

          "maximum": 2,

          "description": "Penalty for repeated tokens; higher values discourage repetition."

        },

        "frequency_penalty": {

          "type": "number",

          "minimum": -2,

          "maximum": 2,

          "description": "Decreases the likelihood of the model repeating the same lines verbatim."

        },

        "presence_penalty": {

          "type": "number",

          "minimum": -2,

          "maximum": 2,

          "description": "Increases the likelihood of the model introducing new topics."

        }

      },

      "required": [

        "messages"

      ]

    }

  ]

}


```

Explain Code

```

{

  "type": "object",

  "contentType": "application/json"

}


```

Streaming — Send a request with \`stream: true\` and receive server-sent events 

* [ Input ](#tab-panel-549)
* [ Output ](#tab-panel-550)

```

{

  "type": "object",

  "oneOf": [

    {

      "title": "Prompt",

      "properties": {

        "prompt": {

          "type": "string",

          "minLength": 1,

          "description": "The input text prompt for the model to generate a response."

        },

        "lora": {

          "type": "string",

          "description": "Name of the LoRA (Low-Rank Adaptation) model to fine-tune the base model."

        },

        "response_format": {

          "title": "JSON Mode",

          "type": "object",

          "properties": {

            "type": {

              "type": "string",

              "enum": [

                "json_object",

                "json_schema"

              ]

            },

            "json_schema": {}

          }

        },

        "raw": {

          "type": "boolean",

          "default": false,

          "description": "If true, a chat template is not applied and you must adhere to the specific model's expected formatting."

        },

        "stream": {

          "type": "boolean",

          "default": false,

          "description": "If true, the response will be streamed back incrementally using SSE, Server Sent Events."

        },

        "max_tokens": {

          "type": "integer",

          "default": 256,

          "description": "The maximum number of tokens to generate in the response."

        },

        "temperature": {

          "type": "number",

          "default": 0.6,

          "minimum": 0,

          "maximum": 5,

          "description": "Controls the randomness of the output; higher values produce more random results."

        },

        "top_p": {

          "type": "number",

          "minimum": 0.001,

          "maximum": 1,

          "description": "Adjusts the creativity of the AI's responses by controlling how many possible words it considers. Lower values make outputs more predictable; higher values allow for more varied and creative responses."

        },

        "top_k": {

          "type": "integer",

          "minimum": 1,

          "maximum": 50,

          "description": "Limits the AI to choose from the top 'k' most probable words. Lower values make responses more focused; higher values introduce more variety and potential surprises."

        },

        "seed": {

          "type": "integer",

          "minimum": 1,

          "maximum": 9999999999,

          "description": "Random seed for reproducibility of the generation."

        },

        "repetition_penalty": {

          "type": "number",

          "minimum": 0,

          "maximum": 2,

          "description": "Penalty for repeated tokens; higher values discourage repetition."

        },

        "frequency_penalty": {

          "type": "number",

          "minimum": -2,

          "maximum": 2,

          "description": "Decreases the likelihood of the model repeating the same lines verbatim."

        },

        "presence_penalty": {

          "type": "number",

          "minimum": -2,

          "maximum": 2,

          "description": "Increases the likelihood of the model introducing new topics."

        }

      },

      "required": [

        "prompt"

      ]

    },

    {

      "title": "Messages",

      "properties": {

        "messages": {

          "type": "array",

          "description": "An array of message objects representing the conversation history.",

          "items": {

            "type": "object",

            "properties": {

              "role": {

                "type": "string",

                "description": "The role of the message sender (e.g., 'user', 'assistant', 'system', 'tool')."

              },

              "content": {

                "oneOf": [

                  {

                    "type": "string",

                    "description": "The content of the message as a string."

                  },

                  {

                    "type": "array",

                    "description": "Array of text content parts.",

                    "items": {

                      "type": "object",

                      "properties": {

                        "type": {

                          "type": "string",

                          "description": "Type of the content (text)"

                        },

                        "text": {

                          "type": "string",

                          "description": "Text content"

                        }

                      }

                    }

                  }

                ]

              }

            },

            "required": [

              "role",

              "content"

            ]

          }

        },

        "functions": {

          "type": "array",

          "items": {

            "type": "object",

            "properties": {

              "name": {

                "type": "string"

              },

              "code": {

                "type": "string"

              }

            },

            "required": [

              "name",

              "code"

            ]

          }

        },

        "tools": {

          "type": "array",

          "description": "A list of tools available for the assistant to use.",

          "items": {

            "type": "object",

            "oneOf": [

              {

                "properties": {

                  "name": {

                    "type": "string",

                    "description": "The name of the tool. More descriptive the better."

                  },

                  "description": {

                    "type": "string",

                    "description": "A brief description of what the tool does."

                  },

                  "parameters": {

                    "type": "object",

                    "description": "Schema defining the parameters accepted by the tool.",

                    "properties": {

                      "type": {

                        "type": "string",

                        "description": "The type of the parameters object (usually 'object')."

                      },

                      "required": {

                        "type": "array",

                        "description": "List of required parameter names.",

                        "items": {

                          "type": "string"

                        }

                      },

                      "properties": {

                        "type": "object",

                        "description": "Definitions of each parameter.",

                        "additionalProperties": {

                          "type": "object",

                          "properties": {

                            "type": {

                              "type": "string",

                              "description": "The data type of the parameter."

                            },

                            "description": {

                              "type": "string",

                              "description": "A description of the expected parameter."

                            }

                          },

                          "required": [

                            "type",

                            "description"

                          ]

                        }

                      }

                    },

                    "required": [

                      "type",

                      "properties"

                    ]

                  }

                },

                "required": [

                  "name",

                  "description",

                  "parameters"

                ]

              },

              {

                "properties": {

                  "type": {

                    "type": "string",

                    "description": "Specifies the type of tool (e.g., 'function')."

                  },

                  "function": {

                    "type": "object",

                    "description": "Details of the function tool.",

                    "properties": {

                      "name": {

                        "type": "string",

                        "description": "The name of the function."

                      },

                      "description": {

                        "type": "string",

                        "description": "A brief description of what the function does."

                      },

                      "parameters": {

                        "type": "object",

                        "description": "Schema defining the parameters accepted by the function.",

                        "properties": {

                          "type": {

                            "type": "string",

                            "description": "The type of the parameters object (usually 'object')."

                          },

                          "required": {

                            "type": "array",

                            "description": "List of required parameter names.",

                            "items": {

                              "type": "string"

                            }

                          },

                          "properties": {

                            "type": "object",

                            "description": "Definitions of each parameter.",

                            "additionalProperties": {

                              "type": "object",

                              "properties": {

                                "type": {

                                  "type": "string",

                                  "description": "The data type of the parameter."

                                },

                                "description": {

                                  "type": "string",

                                  "description": "A description of the expected parameter."

                                }

                              },

                              "required": [

                                "type",

                                "description"

                              ]

                            }

                          }

                        },

                        "required": [

                          "type",

                          "properties"

                        ]

                      }

                    },

                    "required": [

                      "name",

                      "description",

                      "parameters"

                    ]

                  }

                },

                "required": [

                  "type",

                  "function"

                ]

              }

            ]

          }

        },

        "response_format": {

          "title": "JSON Mode",

          "type": "object",

          "properties": {

            "type": {

              "type": "string",

              "enum": [

                "json_object",

                "json_schema"

              ]

            },

            "json_schema": {}

          }

        },

        "raw": {

          "type": "boolean",

          "default": false,

          "description": "If true, a chat template is not applied and you must adhere to the specific model's expected formatting."

        },

        "stream": {

          "type": "boolean",

          "default": false,

          "description": "If true, the response will be streamed back incrementally using SSE, Server Sent Events."

        },

        "max_tokens": {

          "type": "integer",

          "default": 256,

          "description": "The maximum number of tokens to generate in the response."

        },

        "temperature": {

          "type": "number",

          "default": 0.6,

          "minimum": 0,

          "maximum": 5,

          "description": "Controls the randomness of the output; higher values produce more random results."

        },

        "top_p": {

          "type": "number",

          "minimum": 0.001,

          "maximum": 1,

          "description": "Adjusts the creativity of the AI's responses by controlling how many possible words it considers. Lower values make outputs more predictable; higher values allow for more varied and creative responses."

        },

        "top_k": {

          "type": "integer",

          "minimum": 1,

          "maximum": 50,

          "description": "Limits the AI to choose from the top 'k' most probable words. Lower values make responses more focused; higher values introduce more variety and potential surprises."

        },

        "seed": {

          "type": "integer",

          "minimum": 1,

          "maximum": 9999999999,

          "description": "Random seed for reproducibility of the generation."

        },

        "repetition_penalty": {

          "type": "number",

          "minimum": 0,

          "maximum": 2,

          "description": "Penalty for repeated tokens; higher values discourage repetition."

        },

        "frequency_penalty": {

          "type": "number",

          "minimum": -2,

          "maximum": 2,

          "description": "Decreases the likelihood of the model repeating the same lines verbatim."

        },

        "presence_penalty": {

          "type": "number",

          "minimum": -2,

          "maximum": 2,

          "description": "Increases the likelihood of the model introducing new topics."

        }

      },

      "required": [

        "messages"

      ]

    }

  ]

}


```

Explain Code

```

{

  "type": "string",

  "contentType": "text/event-stream",

  "format": "binary"

}


```

Batch — Send multiple requests in a single API call 

* [ Input ](#tab-panel-545)
* [ Output ](#tab-panel-546)

```

{

  "type": "object",

  "title": "Responses_Async",

  "properties": {

    "requests": {

      "type": "array",

      "items": {

        "type": "object",

        "properties": {

          "input": {

            "anyOf": [

              {

                "type": "string"

              },

              {

                "items": {},

                "type": "array"

              }

            ],

            "description": "Responses API Input messages. Refer to OpenAI Responses API docs to learn more about supported content types"

          },

          "reasoning": {

            "type": "object",

            "properties": {

              "effort": {

                "type": "string",

                "description": "Constrains effort on reasoning for reasoning models. Currently supported values are low, medium, and high. Reducing reasoning effort can result in faster responses and fewer tokens used on reasoning in a response.",

                "enum": [

                  "low",

                  "medium",

                  "high"

                ]

              },

              "summary": {

                "type": "string",

                "description": "A summary of the reasoning performed by the model. This can be useful for debugging and understanding the model's reasoning process. One of auto, concise, or detailed.",

                "enum": [

                  "auto",

                  "concise",

                  "detailed"

                ]

              }

            }

          }

        },

        "required": [

          "input"

        ]

      }

    }

  },

  "required": [

    "requests"

  ]

}


```

Explain Code

```

{

  "type": "object",

  "contentType": "application/json"

}


```

```json
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@id":"/directory/","name":"Directory"}},{"@type":"ListItem","position":2,"item":{"@id":"/ai/","name":"AI"}},{"@type":"ListItem","position":3,"item":{"@id":"/ai/models/","name":"Models"}}]}
```