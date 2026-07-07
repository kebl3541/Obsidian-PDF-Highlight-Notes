import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  View,
  normalizePath,
} from "obsidian";

interface PdfHighlightSettings {
  // Folder where imported PDFs are stored.
  pdfFolder: string;
  // Folder where highlight notes are created.
  highlightsFolder: string;
  // Open the highlights note beside the PDF after saving a highlight.
  openNoteAfterHighlight: boolean;
}

const DEFAULT_SETTINGS: PdfHighlightSettings = {
  pdfFolder: "PDFs",
  highlightsFolder: "PDF Highlights",
  openNoteAfterHighlight: false,
};

// The built-in PDF view isn't part of Obsidian's public typings; we only
// touch the small surface we need.
interface PdfViewLike extends View {
  file: TFile | null;
  containerEl: HTMLElement;
}

// Where a selection starts or ends inside a pdf.js text layer:
// index of the text-layer child element, plus a character offset within it.
interface TextLayerPosition {
  index: number;
  offset: number;
}

export default class PdfHighlightNotesPlugin extends Plugin {
  settings: PdfHighlightSettings = DEFAULT_SETTINGS;

  // One floating save-button per window (main window + popouts).
  private selectionButtons = new Map<Document, HTMLButtonElement>();

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "import-pdfs",
      name: "Import PDF files into vault",
      callback: () => this.importPdfs(),
    });

    this.addCommand({
      id: "save-highlight",
      name: "Save PDF selection as highlight",
      callback: () => void this.saveHighlight(),
    });

    this.addCommand({
      id: "open-highlights-note",
      name: "Open highlights note for this PDF",
      callback: () => void this.openHighlightsNoteCommand(),
    });

    this.addRibbonIcon("file-up", "Import PDF files", () => this.importPdfs());
    this.addRibbonIcon("highlighter", "Save PDF selection as highlight", () =>
      void this.saveHighlight()
    );

    // Floating "Save highlight" button that appears next to a PDF text
    // selection, so no command or hotkey is needed. Registered per window so
    // popouts work too.
    this.setupSelectionButton(activeDocument);
    this.registerEvent(
      this.app.workspace.on("window-open", (win) =>
        this.setupSelectionButton(win.doc)
      )
    );

    this.addSettingTab(new PdfHighlightSettingTab(this));
  }

  onunload() {
    for (const btn of this.selectionButtons.values()) btn.remove();
    this.selectionButtons.clear();
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<PdfHighlightSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- Import -------------------------------------------------------------

  private importPdfs() {
    const input = activeDocument.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.multiple = true;
    input.addEventListener("change", () => {
      void (async () => {
        const files = Array.from(input.files ?? []);
        if (files.length === 0) return;
        let firstImported: TFile | null = null;
        for (const f of files) {
          const imported = await this.importOne(f);
          firstImported = firstImported ?? imported;
        }
        new Notice(
          files.length === 1
            ? `Imported ${files[0].name}`
            : `Imported ${files.length} PDFs`
        );
        // Open the first imported PDF in the built-in viewer.
        if (firstImported) {
          await this.app.workspace.getLeaf(true).openFile(firstImported);
        }
      })();
    });
    input.click();
  }

  private async importOne(f: globalThis.File): Promise<TFile | null> {
    const folder = await this.ensureFolder(this.settings.pdfFolder);
    const data = await f.arrayBuffer();

    // Avoid overwriting an existing file with the same name.
    let base = f.name.replace(/\.pdf$/i, "");
    let path = normalizePath(`${folder.path}/${base}.pdf`);
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder.path}/${base} ${n}.pdf`);
      n++;
    }
    return this.app.vault.createBinary(path, data);
  }

  private async ensureFolder(path: string): Promise<TFolder> {
    const normalized = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) return existing;
    if (existing) {
      throw new Error(`${normalized} exists but is not a folder`);
    }
    return this.app.vault.createFolder(normalized);
  }

  // ---- Floating selection button -------------------------------------------

  private setupSelectionButton(doc: Document) {
    this.registerDomEvent(doc, "selectionchange", () =>
      this.updateSelectionButton(doc)
    );
    // Hide while scrolling so the button doesn't drift from the selection.
    this.registerDomEvent(
      doc,
      "wheel",
      () => this.hideSelectionButton(doc),
      { capture: true, passive: true }
    );
  }

  private getSelectionButton(doc: Document): HTMLButtonElement {
    let btn = this.selectionButtons.get(doc);
    if (btn) return btn;
    btn = doc.createElement("button");
    btn.className = "pdf-highlight-notes-save-btn";
    btn.setText("Save highlight");
    // pointerdown (not click) + preventDefault, so the PDF selection is still
    // alive when we read it.
    btn.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      void this.saveHighlight().then(() => this.hideSelectionButton(doc));
    });
    doc.body.appendChild(btn);
    this.selectionButtons.set(doc, btn);
    return btn;
  }

  private hideSelectionButton(doc: Document) {
    const btn = this.selectionButtons.get(doc);
    if (btn) btn.removeClass("is-visible");
  }

  private updateSelectionButton(doc: Document) {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.hideSelectionButton(doc);
      return;
    }
    // Only offer the button for selections inside a PDF text layer.
    const range = sel.getRangeAt(0);
    if (!this.closestElement(range.startContainer, ".textLayer")) {
      this.hideSelectionButton(doc);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hideSelectionButton(doc);
      return;
    }
    const btn = this.getSelectionButton(doc);
    btn.addClass("is-visible");
    const margin = 8;
    const top = Math.max(margin, rect.top - 34);
    const left = Math.max(margin, rect.left + rect.width / 2 - 55);
    btn.style.top = `${top}px`;
    btn.style.left = `${left}px`;
  }

  // ---- Highlighting -------------------------------------------------------

  private getActivePdfView(): PdfViewLike | null {
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      const view = leaf.view as PdfViewLike;
      // Prefer the PDF view that owns the current selection / focus.
      const sel = activeWindow.getSelection();
      if (
        sel &&
        sel.rangeCount > 0 &&
        view.containerEl.contains(sel.getRangeAt(0).startContainer)
      ) {
        return view;
      }
    }
    // Fall back to the active leaf if it is a PDF.
    const active = this.app.workspace.getActiveViewOfType(View);
    if (active && active.getViewType() === "pdf") {
      return active as PdfViewLike;
    }
    return null;
  }

  private async saveHighlight() {
    const view = this.getActivePdfView();
    const file = view?.file;
    if (!view || !file) {
      new Notice("Open a PDF and select some text first.");
      return;
    }

    const sel = activeWindow.getSelection();
    const quote = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (!sel || sel.rangeCount === 0 || quote === "") {
      new Notice("Select some text in the PDF first.");
      return;
    }

    const range = sel.getRangeAt(0);
    const pageEl = this.closestElement(range.startContainer, ".page");
    const pageAttr = pageEl?.getAttribute("data-page-number");
    const page = pageAttr ? parseInt(pageAttr, 10) : NaN;
    if (!pageEl || Number.isNaN(page)) {
      new Notice("Could not determine the PDF page of the selection.");
      return;
    }

    // Build the same subpath Obsidian uses for "copy link to selection":
    // #page=N&selection=startIndex,startOffset,endIndex,endOffset
    let subpath = `#page=${page}`;
    const textLayer = pageEl.querySelector(".textLayer");
    if (textLayer) {
      const start = this.textLayerPosition(
        textLayer,
        range.startContainer,
        range.startOffset
      );
      const end = this.textLayerPosition(
        textLayer,
        range.endContainer,
        range.endOffset
      );
      if (start && end) {
        subpath += `&selection=${start.index},${start.offset},${end.index},${end.offset}`;
      }
    }

    const note = await this.getOrCreateHighlightsNote(file);
    const link = this.app.fileManager
      .generateMarkdownLink(file, note.path, subpath, `p. ${page}`)
      .replace(/^!/, ""); // embed marker would render the PDF inline

    const entry = [
      "",
      `> [!quote] ${link}`,
      ...quote.split("\n").map((l) => `> ${l}`),
      "",
    ].join("\n");

    await this.app.vault.append(note, entry);
    new Notice(`Highlight saved to ${note.basename}`);

    if (this.settings.openNoteAfterHighlight) {
      await this.openBeside(note);
    }
  }

  // Map a DOM position inside the text layer to Obsidian's
  // (childIndex, charOffset) selection coordinates.
  private textLayerPosition(
    textLayer: Element,
    node: Node,
    offset: number
  ): TextLayerPosition | null {
    const children = Array.from(textLayer.children);
    // The selection endpoint can be the text layer itself; offset is then a
    // child index directly.
    if (node === textLayer) {
      return { index: Math.min(offset, children.length), offset: 0 };
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child === node || child.contains(node)) {
        // Character offset = text before `node` within this child + offset.
        let chars = 0;
        const walker = activeDocument.createTreeWalker(child, NodeFilter.SHOW_TEXT);
        let t: Node | null;
        while ((t = walker.nextNode())) {
          if (t === node) break;
          chars += t.textContent?.length ?? 0;
        }
        const within = node.nodeType === Node.TEXT_NODE ? offset : 0;
        return { index: i, offset: chars + within };
      }
    }
    return null;
  }

  private closestElement(node: Node, selector: string): Element | null {
    const el =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    return el?.closest(selector) ?? null;
  }

  // ---- Highlights note ------------------------------------------------------

  private highlightsNotePath(pdf: TFile): string {
    return normalizePath(
      `${this.settings.highlightsFolder}/${pdf.basename} (highlights).md`
    );
  }

  private async getOrCreateHighlightsNote(pdf: TFile): Promise<TFile> {
    const path = this.highlightsNotePath(pdf);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;

    await this.ensureFolder(this.settings.highlightsFolder);
    const link = this.app.fileManager.generateMarkdownLink(pdf, path);
    const header = `# Highlights: ${pdf.basename}\n\nSource: ${link.replace(/^!/, "")}\n`;
    return this.app.vault.create(path, header);
  }

  private async openHighlightsNoteCommand() {
    const view = this.getActivePdfView();
    const file =
      view?.file ??
      (this.app.workspace.getActiveFile()?.extension === "pdf"
        ? this.app.workspace.getActiveFile()
        : null);
    if (!file) {
      new Notice("Open a PDF first.");
      return;
    }
    const note = await this.getOrCreateHighlightsNote(file);
    await this.openBeside(note);
  }

  private async openBeside(note: TFile) {
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(note);
  }
}

// ---- Settings --------------------------------------------------------------

class PdfHighlightSettingTab extends PluginSettingTab {
  plugin: PdfHighlightNotesPlugin;

  constructor(plugin: PdfHighlightNotesPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("PDF folder")
      .setDesc("Vault folder where imported PDFs are stored.")
      .addText((text) =>
        text
          .setPlaceholder("PDFs")
          .setValue(this.plugin.settings.pdfFolder)
          .onChange(async (v) => {
            this.plugin.settings.pdfFolder = v.trim() || "PDFs";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Highlights folder")
      .setDesc("Vault folder where highlight notes are created.")
      .addText((text) =>
        text
          .setPlaceholder("PDF Highlights")
          .setValue(this.plugin.settings.highlightsFolder)
          .onChange(async (v) => {
            this.plugin.settings.highlightsFolder = v.trim() || "PDF Highlights";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Open note after highlighting")
      .setDesc("Open the highlights note beside the PDF after saving a highlight.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openNoteAfterHighlight)
          .onChange(async (v) => {
            this.plugin.settings.openNoteAfterHighlight = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
