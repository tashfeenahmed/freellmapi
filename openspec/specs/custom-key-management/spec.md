## Purpose

Custom API key management allows users to register OpenAI-compatible endpoints and bind models to specific keys. Each custom key independently holds its own model registrations.

## Requirements

### Requirement: Custom 平台支持同 base_url 多 key

系统 SHALL 允许用户为同一个 `base_url` 添加多个独立的 API key，每次提交创建一个新的 key 行，不覆盖已有 key。

#### Scenario: 同一 base_url 添加第二个 key
- **WHEN** 用户已有 `base_url=http://localhost:11434/v1` 的 custom key，再提交相同 base_url 但不同 apiKey 的 custom 请求
- **THEN** 系统创建一个新的 `api_keys` 行（新的 id、新的 encrypted_key），两个 key 互不覆盖

#### Scenario: 同一 base_url 添加相同 key 值
- **WHEN** 用户提交与已有 key 完全相同的 base_url 和 apiKey
- **THEN** 系统仍然创建一个新的 `api_keys` 行（不检查 apiKey 重复）

### Requirement: 不同 key 注册的同名 model 互不冲突

系统 SHALL 确保不同 custom key 注册的同名 model（如两个 key 都注册 `qwen3:4b`）在 `models` 表中各自拥有独立的行，互不覆盖对方的 `key_id` 绑定。

#### Scenario: 两个 key 注册同名 model
- **WHEN** key A 注册了 model `qwen3:4b`，key B（同 base_url 不同 key）也注册 model `qwen3:4b`
- **THEN** `models` 表中有两条 `platform='custom'`、不同 model_id 的行，各自绑定到正确的 key_id

#### Scenario: 同一个 key 重新注册已存在的 model
- **WHEN** key A 重新提交之前已注册的 model `qwen3:4b`（同 key_id、同原名）
- **THEN** 系统更新该 model 行的 `display_name`、`key_id` 和 `enabled`，不创建新行

### Requirement: 删除 custom key 仅影响自身绑定的 model

系统 SHALL 在删除 custom key 时仅删除该 key 绑定的 model 行，不同 base_url 或同 base_url 的其他 key 的 model 不受影响。

#### Scenario: 删除一个 key，兄弟 key 的 model 保持完整
- **WHEN** 同 base_url 下存在 key A（注册了 model-a）和 key B（注册了 model-b），用户删除 key A
- **THEN** model-a 被删除，model-b 继续存在且绑定到 key B
