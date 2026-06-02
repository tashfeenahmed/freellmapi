# Feature Specification: Import Keys Modal with Preview Table

**Feature Branch**: `contrib/ollama-local`

**Created**: 2026-05-31

**Status**: Draft

**Input**: User request (Dutch): Modal for importing multiple API key files with preview table

## User Scenarios & Testing

### User Story 1 - Upload Multiple Files and Preview Keys (Priority: P1)
As a user, I want to upload multiple .env/.json/.md/.txt files at once and see a preview of all detected API keys before importing them.

**Why this priority**: Core workflow — without preview, the user can't verify what will be imported.

**Independent Test**: Upload 2 .env files → preview shows keys from both files combined.

**Acceptance Scenarios**:
1. **Given** the Keys page, **When** I click "Import keys", **Then** a modal dialog opens
2. **Given** the modal is open, **When** I select 2 .env files (not 1), **Then** both files are accepted
3. **Given** files are selected, **When** I click "Preview", **Then** a table shows each detected key with its provider, name, and value
4. **Given** the preview table is shown, **When** there are unrecognized keys, **Then** they are listed in a "skipped" section

### User Story 2 - Edit and Select Keys Before Import (Priority: P2)
As a user, I want to edit the detected provider, modify key values, and uncheck keys I don't want to import.

**Why this priority**: Users may have keys with unrecognized prefixes or want to correct auto-detected platforms.

**Independent Test**: Uncheck 1 of 2 keys → only 1 key gets imported.

**Acceptance Scenarios**:
1. **Given** the preview table, **When** I change a key's platform via dropdown, **Then** it maps to the correct provider
2. **Given** the preview table, **When** I edit the key value input, **Then** the edited value is used on import
3. **Given** a row has a show/hide toggle, **When** I click it, **Then** the key value toggles between masked and visible
4. **Given** a checkbox is unchecked, **When** I click "Import selected", **Then** that key is NOT imported

### User Story 3 - Import Selected Keys (Priority: P1)
As a user, I want to click "Import selected" and see the results (success count, skipped keys, errors).

**Why this priority**: The actual import is the primary goal.

**Independent Test**: Click "Import selected" with 2 checked keys → both appear in the keys list.

**Acceptance Scenarios**:
1. **Given** at least one key is checked, **When** I click "Import selected", **Then** a loading state is shown
2. **Given** import succeeds, **When** complete, **Then** the modal closes and the keys list refreshes
3. **Given** import has errors, **When** complete, **Then** error details are shown inside the modal (it does not close)

### Edge Cases
- Empty file upload → show "file contains no data" error
- Unsupported file type (.js, .pdf, etc.) → show "unsupported file type" error
- All keys unchecked → "Import selected" button is disabled
- Network failure during preview or import → show error in modal
- Very large key values (2000+ chars) → input field scrolls/handles them
- Same key name in multiple files → both appear as separate rows

## Requirements

### Functional Requirements
- **FR-001**: System MUST accept multiple file uploads simultaneously (.env, .json, .jsonc, .md, .txt)
- **FR-002**: System MUST parse each file and preview keys WITHOUT storing them in the database
- **FR-003**: Preview MUST show: checkbox (default on), editable platform dropdown, key name, key value with show/hide toggle
- **FR-004**: System MUST import only checked keys when "Import selected" is clicked
- **FR-005**: System MUST validate platform against the allowed platforms list
- **FR-006**: System MUST encrypt key values before storing (AES-256-GCM)
- **FR-007**: System MUST return import results: imported count, skipped keys, errors
- **FR-008**: Old inline Batch Import section MUST be replaced by the modal

### Key Entities
- **PreviewKey**: keyName, keyValue, detectedPlatform, prefix — represents a parsed key before import
- **ImportKey**: keyName, keyValue, platform — represents a user-confirmed key to import
- **ImportResult**: imported, skipped, errors, total — result of the import operation

## Success Criteria

### Measurable Outcomes
- **SC-001**: User can upload 5 files at once and preview all parsed keys
- **SC-002**: User can complete the full flow (upload → preview → select → import) in under 30 seconds for 10 keys
- **SC-003**: All 268 existing server tests remain green after implementation
- **SC-004**: Import-selected endpoint handles up to 100 keys per request

## Assumptions
- `.md` files are parsed as plain text (KEY=VALUE lines), same as `.env` files
- `.jsonc` files are parsed as JSON (same as `.json`)
- The old POST /api/keys/import endpoint remains for backward compatibility
- No toast/notification system exists — results are shown in the modal
- No deduplication is needed — duplicate keys get new rows (same as current behavior)
