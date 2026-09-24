# Rename commercial property URL import

## Scope
- Update the New Commercial Property dialog shown in the screenshot.
- Rename the visible URL-import language from “scrape” to “extract”.
- Preserve the existing URL processing, PDF/image import, field population, validation, and save behaviour.

## Changes
- Rename the panel description to explain URL extraction and document import.
- Rename the URL tab to “URL Extraction”.
- Rename the action and progress states to “Extract URL” and “Extracting…”.
- Update URL validation, timeout, failure, and success messages to use the same extraction terminology.
- Leave internal function names and server calls unchanged to avoid functional risk.

## Verification
- Clear current TypeScript preview errors.
- Run the targeted tests, style audit, lint, and production build.
- Open the commercial property dialog in the browser and confirm the renamed controls and error-free interaction.
