<!-- 注意：以下英文区块标题与标记为 OpenSpec 解析器硬依赖，不能改成中文。正文内容请全部使用中文。 -->

## ADDED Requirements

### Requirement: <!-- requirement 名称 -->
<!-- Trace: proposal.md#<capability-name> / <业务目标或变更点> -->
<!-- requirement 正文：描述系统新增的正确行为，不写实现方案 -->

#### Scenario: <!-- scenario 名称 -->
- **WHEN** <!-- 条件 / 触发 -->
- **THEN** <!-- 预期结果 -->

## MODIFIED Requirements

### Requirement: <!-- 既有 requirement 名称 -->
<!-- Trace: proposal.md#<capability-name> / <业务目标或变更点> -->
<!-- 这里要放“完整复制并更新后的 requirement block”，不要只写差异。 -->

#### Scenario: <!-- scenario 名称 -->
- **WHEN** <!-- 条件 / 触发 -->
- **THEN** <!-- 预期结果 -->

## REMOVED Requirements

### Requirement: <!-- 被移除的 requirement 名称 -->
**Reason**: <!-- 为什么移除 -->
**Migration**: <!-- 如何迁移 / 替代方案 -->
**Trace**: <!-- proposal.md#<capability-name> / 决策依据 -->

## RENAMED Requirements

- FROM: `### Requirement: <!-- 旧名称 -->`
- TO: `### Requirement: <!-- 新名称 -->`
**Trace**: <!-- proposal.md#<capability-name> / 决策依据 -->

## SPEC SELF-CHECK

- [ ] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [ ] 每个 Requirement 至少包含一个 `#### Scenario:`
- [ ] Scenario 描述的是可观察行为，不是内部实现步骤
- [ ] MODIFIED Requirements 已完整复制旧 requirement block 后再修改
- [ ] 未把纯实现重构写成对外行为变化

