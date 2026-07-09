# PDF Highlight Notes

[![Downloads](https://img.shields.io/github/downloads/kebl3541/Obsidian-PDF-Highlight-Notes/total?style=flat&logo=github&label=Downloads&color=success&cacheSeconds=3600)](https://github.com/kebl3541/Obsidian-PDF-Highlight-Notes/releases)
[![GitHub stars](https://img.shields.io/github/stars/kebl3541/Obsidian-PDF-Highlight-Notes?style=flat&logo=github&label=Stars&cacheSeconds=300)](https://github.com/kebl3541/Obsidian-PDF-Highlight-Notes/stargazers)
[![Latest release](https://img.shields.io/github/v/release/kebl3541/Obsidian-PDF-Highlight-Notes?style=flat&label=Release&cacheSeconds=3600)](https://github.com/kebl3541/Obsidian-PDF-Highlight-Notes/releases/latest)



An Obsidian plugin to **import, read, and highlight PDFs** inside your vault.

<p align="center">If this plugin adds value for you and you would like to help support
continued development, please use the buttons below:</p>

<p align="center">
<a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR"><img src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png" alt="PayPal" height="42"></a>
&nbsp;&nbsp;
<a href="https://buymeacoffee.com/philosophizer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="52"></a>
</p>

<p align="center"><strong><a href="https://buymeacoffee.com/philosophizer">☕ Buy me a coffee</a></strong>&nbsp;&nbsp;·&nbsp;&nbsp;<strong><a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR">💙 Donate via PayPal</a></strong></p>

<p align="center">If you like this plugin or find it useful, please consider giving it a <a href="https://github.com/kebl3541/Obsidian-PDF-Highlight-Notes">star</a> <a href="https://github.com/kebl3541/Obsidian-PDF-Highlight-Notes"><img src="https://img.shields.io/github/stars/kebl3541/Obsidian-PDF-Highlight-Notes?style=social&cacheSeconds=300" alt="GitHub Repo stars"></a> on GitHub!</p>


PDFs open in Obsidian's built-in viewer. Select a passage and a small floating
toolbar appears with two **independent** actions:

- **Highlight**: paints a permanent marker highlight **into the PDF file
  itself**, like a real highlighter on paper. The ink stays across restarts and
  is visible in any PDF reader (Preview, Acrobat, …). Colors: yellow (default),
  green, pink, or blue.
- **Save quote**: saves the passage as a quote in a companion *highlights
  note*, with a deep link that reopens the PDF at that exact passage. The PDF
  file is not modified. Your quotes are ordinary Markdown: searchable,
  linkable, and taggable.

Use either one, or both. They don't affect each other.

## Commands

- **Import PDF files into vault**: file picker; copies PDFs into your vault
  (folder configurable) and opens the first one. Also available as a ribbon
  button.
- **Save PDF selection as highlight**: with text selected in an open PDF,
  saves it as a `> [!quote]` callout in `PDF Highlights/<name> (highlights).md`,
  linked back to the page and selection. Bind this to a hotkey for one-press
  highlighting. Also available as a ribbon button.
- **Open highlights note for this PDF**: opens the companion note beside the
  PDF.

## Example highlight

```markdown
> [!quote] [[PDFs/agent_smith.pdf#page=4&selection=12,0,15,42|p. 4]]
> The measured capability of the agent exceeded expectations across all tasks.
```

Clicking the link reopens the PDF on page 4 with the passage highlighted by
Obsidian's native viewer.

## Settings

- **PDF folder**: where imported PDFs are stored (default `PDFs`).
- **Highlights folder**: where highlight notes are created (default
  `PDF Highlights`).
- **Open note after highlighting**: show the highlights note beside the PDF
  after each save.

## Install (manual)

1. `npm install && npm run build`
2. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<YourVault>/.obsidian/plugins/pdf-highlight-notes/`
3. Enable **PDF Highlight Notes** under Settings → Community plugins.

## Support

If this plugin adds value for you and you would like to help support continued
development, please use the buttons below:

<a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR"><img src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png" alt="PayPal" height="42"></a>
&nbsp;&nbsp;
<a href="https://buymeacoffee.com/philosophizer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="52"></a>


## License

MIT
