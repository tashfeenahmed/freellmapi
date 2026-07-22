# Throttler Middleware Demo

## Overview

This document demonstrates the behavior of the throttler middleware with different providers and rate limits. The throttler middleware applies variable delays based on provider-specific rate limits and current usage.

## Provider Rate Limits

The following table shows the rate limits for each provider:

| Provider   | RPM Limit | TPM Limit | Delay Threshold |
|------------|-----------|-----------|-----------------|
| Anthropic  | 60        | 100,000   | 80%             |
| Mistral    | 2         | 100,000   | 80%             |
| NVIDIA     | 40        | 100,000   | 80%             |

## Test Cases

### Test 1: Anthropic - RPM limit exceeded

**Scenario**: Request count exceeds the RPM limit for the Anthropic provider.

**Parameters**:
- RPM used: 70
- RPM limit: 60
- Threshold: 80%

**Calculation**:
- Ratio: 70 / 60 = 1.17
- Over threshold: 1.17 - 0.8 = 0.37
- Delay: 0.37 * 60 * 1000 = 22,200ms

**Result**:
- Applied delay: 22,200ms
- Status: PASS

### Test 2: Mistral - RPM limit exceeded

**Scenario**: Request count exceeds the RPM limit for the Mistral provider.

**Parameters**:
- RPM used: 3
- RPM limit: 2
- Threshold: 80%

**Calculation**:
- Ratio: 3 / 2 = 1.5
- Over threshold: 1.5 - 0.8 = 0.7
- Delay: 0.7 * 60 * 1000 = 42,000ms

**Result**:
- Applied delay: 42,000ms
- Status: PASS

### Test 3: NVIDIA - RPM limit exceeded

**Scenario**: Request count exceeds the RPM limit for the NVIDIA provider.

**Parameters**:
- RPM used: 50
- RPM limit: 40
- Threshold: 80%

**Calculation**:
- Ratio: 50 / 40 = 1.25
- Over threshold: 1.25 - 0.8 = 0.45
- Delay: 0.45 * 60 * 1000 = 27,000ms

**Result**:
- Applied delay: 27,000ms
- Status: PASS

### Test 4: Below threshold

**Scenario**: Request count is below the RPM limit for the Anthropic provider.

**Parameters**:
- RPM used: 30
- RPM limit: 60
- Threshold: 80%

**Calculation**:
- Ratio: 30 / 60 = 0.5
- Over threshold: 0.5 < 0.8
- Delay: 0ms

**Result**:
- Applied delay: 0ms
- Status: PASS

### Test 5: Minimum delay

**Scenario**: Request count slightly exceeds the RPM limit for the NVIDIA provider.

**Parameters**:
- RPM used: 49
- RPM limit: 40
- Threshold: 80%

**Calculation**:
- Ratio: 49 / 40 = 1.225
- Over threshold: 1.225 - 0.8 = 0.425
- Delay: 0.425 * 60 * 1000 = 25,500ms

**Result**:
- Applied delay: 25,500ms
- Status: PASS

## Conclusion

The throttler middleware successfully applies variable delays based on provider-specific rate limits and current usage. The delay calculation takes into account the provider's RPM and TPM limits and applies a delay when the usage exceeds a configurable threshold.

## Implementation Details

The throttler middleware is implemented as follows:

1. **Configuration**: Provider-specific rate limits and delay thresholds are configured in a JSON file.
2. **Middleware**: The throttler middleware is registered after the rate limiter middleware in the Express app.
3. **Delay Calculation**: The delay is calculated based on the current usage and provider limits.
4. **Application**: The delay is applied to requests that exceed the configured thresholds.

This approach helps to prevent hitting model provider rate limits by applying variable delays based on the provider's rate limits and current usage.