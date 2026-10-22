# Alpha Cursor

Alpha Cursor is a Chrome Manifest V3 productivity extension. Middle-click a
page to open its radial tool panel, or use the toolbar popup and options page
to manage the extension.

## Features

- Capture copied text in a notepad and manage saved tabs
- Capture full-page screenshots and save images
- Search selected text, download media, and pick colors
- Extract text from a selected screen area with locally bundled OCR assets
- Use voice-to-text, shift between tabs, and scroll horizontally
- Toggle automatic copy capture and cookie-consent popup removal

## Requirements

- Node.js 18 or newer
- npm
- Google Chrome with Manifest V3 support

## Build and install locally

```sh
npm ci
npm run build
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose
**Load unpacked**, and select the generated `dist` directory.

For development, run `npm run dev`. The extension uses Vite and CRXJS; see the
terminal output for the development build instructions.

## Project scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm run build` | Build the extension into `dist` |
| `npm test` | Run the Vitest test suite |
| `npm run typecheck` | Type-check the TypeScript project |

## Permissions and privacy

Alpha Cursor requests Chrome's `storage`, `tabs`, `downloads`, `offscreen`, and
`favicon` permissions, and access to pages through the `<all_urls>` host
permission. These support its settings, tab tools, downloads, OCR, and
page-interaction features. OCR worker and language assets are bundled with the
extension rather than loaded as remote executable code. Review the Chrome
permission prompts and the extension source before installing.
