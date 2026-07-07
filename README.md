# PDF Highlight Notes

An Obsidian plugin to **import, read, and highlight PDFs** inside your vault.

PDFs open in Obsidian's built-in viewer. When you select a passage, one command
saves it as a quote in a companion *highlights note* — with a deep link that
reopens the PDF **at that exact passage, highlighted**. Your highlights become
ordinary Markdown: searchable, linkable, and taggable like any other note.

## Commands

- **Import PDF files into vault** — file picker; copies PDFs into your vault
  (folder configurable) and opens the first one. Also available as a ribbon
  button.
- **Save PDF selection as highlight** — with text selected in an open PDF,
  saves it as a `> [!quote]` callout in `PDF Highlights/<name> (highlights).md`,
  linked back to the page and selection. Bind this to a hotkey for one-press
  highlighting. Also available as a ribbon button.
- **Open highlights note for this PDF** — opens the companion note beside the
  PDF.

## Example highlight

```markdown
> [!quote] [[PDFs/agent_smith.pdf#page=4&selection=12,0,15,42|p. 4]]
> The measured capability of the agent exceeded expectations across all tasks.
```

Clicking the link reopens the PDF on page 4 with the passage highlighted by
Obsidian's native viewer.

## Settings

- **PDF folder** — where imported PDFs are stored (default `PDFs`).
- **Highlights folder** — where highlight notes are created (default
  `PDF Highlights`).
- **Open note after highlighting** — show the highlights note beside the PDF
  after each save.

## Install (manual)

1. `npm install && npm run build`
2. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<YourVault>/.obsidian/plugins/pdf-highlight-notes/`
3. Enable **PDF Highlight Notes** under Settings → Community plugins.

## Support

If this plugin is useful to you, you can
[buy me a coffee](https://buymeacoffee.com/philosophizer). ☕

## License

MIT
