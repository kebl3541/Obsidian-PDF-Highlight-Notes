import {
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  View,
  normalizePath,
  setIcon,
} from "obsidian";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";

interface PdfHighlightSettings {
  // Folder where imported PDFs are stored.
  pdfFolder: string;
  // Folder where highlight notes are created.
  highlightsFolder: string;
  // Open the highlights note beside the PDF after saving a quote.
  openNoteAfterHighlight: boolean;
  // Marker color painted into the PDF file.
  highlightColor: keyof typeof HIGHLIGHT_COLORS;
  // Underline color (independent from the marker fill).
  underlineColor: keyof typeof UNDERLINE_COLORS;
  // "ink" writes permanent annotations into the PDF file (visible anywhere,
  // reloads the viewer). "overlay" draws on screen only — no file change and
  // no reload, but marks exist only inside Obsidian with this plugin enabled.
  markerMode: "ink" | "overlay";
}

// An overlay mark: rectangles as fractions (0..1) of the rendered page, so
// they reposition correctly at any zoom level.
interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OverlayMark {
  id: string;
  page: number;
  style: MarkerStyle;
  color: string;
  rects: OverlayRect[];
  quote: string;
}

// Shape of data.json: settings plus overlay marks keyed by file path.
interface PersistedData {
  settings: PdfHighlightSettings;
  overlays: Record<string, OverlayMark[]>;
}

// RGB in PDF color space (0..1), tuned to look like real marker ink.
const HIGHLIGHT_COLORS = {
  yellow: [1, 0.82, 0.16],
  orange: [1, 0.62, 0.2],
  red: [1, 0.42, 0.38],
  pink: [1, 0.53, 0.72],
  purple: [0.72, 0.53, 1],
  blue: [0.45, 0.72, 1],
  cyan: [0.35, 0.87, 0.93],
  green: [0.47, 0.9, 0.42],
} as const;

type MarkerStyle = "highlight" | "underline";

// Underlines get a black option (and default) — a black marker fill would
// black out the text, so black is only offered for underlines.
const UNDERLINE_COLORS = {
  black: [0, 0, 0],
  ...HIGHLIGHT_COLORS,
} as const;

const DEFAULT_SETTINGS: PdfHighlightSettings = {
  pdfFolder: "PDFs",
  highlightsFolder: "PDF Highlights",
  openNoteAfterHighlight: false,
  highlightColor: "yellow",
  underlineColor: "black",
  markerMode: "ink",
};

// Everything both actions need to know about the current PDF selection.
interface SelectionContext {
  view: PdfViewLike;
  file: TFile;
  range: Range;
  quote: string;
  page: number;
  pageEl: Element;
  textLayer: Element | null;
}

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

  // One floating button toolbar per window (main window + popouts).
  private selectionButtons = new Map<Document, HTMLDivElement>();

  // Overlay marks per file path (persisted in data.json).
  private overlays: Record<string, OverlayMark[]> = {};

  // One DOM observer per PDF view container, re-drawing overlays whenever
  // pdf.js re-renders pages (scroll, zoom, reload).
  private overlayObservers = new Map<HTMLElement, MutationObserver>();

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "import-pdfs",
      name: "Import PDF files into vault",
      callback: () => this.importPdfs(),
    });

    this.addCommand({
      id: "highlight-selection",
      name: "Highlight selection in PDF (marker ink)",
      callback: () => void this.highlightSelection("highlight"),
    });

    this.addCommand({
      id: "underline-selection",
      name: "Underline selection in PDF",
      callback: () => void this.highlightSelection("underline"),
    });

    this.addCommand({
      id: "erase-marker",
      name: "Erase marker under selection",
      callback: () => void this.eraseUnderSelection(),
    });

    this.addCommand({
      id: "save-quote",
      name: "Save PDF selection to highlights note",
      callback: () => void this.saveQuote(),
    });

    this.addCommand({
      id: "open-highlights-note",
      name: "Open highlights note for this PDF",
      callback: () => void this.openHighlightsNoteCommand(),
    });

    this.addRibbonIcon("file-up", "Import PDF files", () => this.importPdfs());
    this.addRibbonIcon("highlighter", "Highlight selection in PDF", () =>
      void this.highlightSelection("highlight")
    );

    // Floating buttons that appear next to a PDF text selection, so no
    // command or hotkey is needed. Registered per window so popouts work too.
    this.setupSelectionButton(activeDocument);
    this.registerEvent(
      this.app.workspace.on("window-open", (win) =>
        this.setupSelectionButton(win.doc)
      )
    );

    this.addSettingTab(new PdfHighlightSettingTab(this));

    // Overlay marks: redraw when layouts/files change, and keep the stored
    // marks attached to files across renames and deletes.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.renderAllOverlays())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.renderAllOverlays())
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        if (this.overlays[oldPath]) {
          this.overlays[f.path] = this.overlays[oldPath];
          delete this.overlays[oldPath];
          void this.saveSettings();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        if (this.overlays[f.path]) {
          delete this.overlays[f.path];
          void this.saveSettings();
        }
      })
    );
    this.app.workspace.onLayoutReady(() => this.renderAllOverlays());
  }

  onunload() {
    for (const btn of this.selectionButtons.values()) btn.remove();
    this.selectionButtons.clear();
    for (const obs of this.overlayObservers.values()) obs.disconnect();
    this.overlayObservers.clear();
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      (leaf.view as PdfViewLike).containerEl
        .querySelectorAll(".pdf-highlight-notes-overlay")
        .forEach((el) => el.remove());
    }
  }

  async loadSettings() {
    const raw = (await this.loadData()) as Record<string, unknown> | null;
    if (raw && typeof raw === "object" && "settings" in raw) {
      const data = raw as unknown as PersistedData;
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      this.overlays = data.overlays ?? {};
    } else {
      // Older data.json stored the settings object directly.
      this.settings = Object.assign(
        {},
        DEFAULT_SETTINGS,
        raw as Partial<PdfHighlightSettings> | null
      );
      this.overlays = {};
    }
  }

  async saveSettings() {
    const data: PersistedData = { settings: this.settings, overlays: this.overlays };
    await this.saveData(data);
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

  private async importOne(f: File): Promise<TFile | null> {
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

  private getSelectionButton(doc: Document): HTMLDivElement {
    let bar = this.selectionButtons.get(doc);
    if (bar) return bar;
    bar = doc.createElement("div");
    bar.className = "pdf-highlight-notes-toolbar";

    // pointerdown (not click) + preventDefault, so the PDF selection is still
    // alive when we read it. One click, current default colors — changing
    // colors happens in the PDF top toolbar.
    const addButton = (label: string, action: () => Promise<void>) => {
      const btn = doc.createElement("button");
      btn.className = "pdf-highlight-notes-btn";
      btn.setText(label);
      btn.addEventListener("pointerdown", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void action().then(() => this.hideSelectionButton(doc));
      });
      bar?.appendChild(btn);
    };

    addButton("Highlight", () => this.highlightSelection("highlight"));
    addButton("Underline", () => this.highlightSelection("underline"));
    addButton("Quote", () => this.saveQuote());
    addButton("Erase", () => this.eraseUnderSelection());

    doc.body.appendChild(bar);
    this.selectionButtons.set(doc, bar);
    return bar;
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
    const left = Math.max(margin, rect.left + rect.width / 2 - 85);
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

  // Everything both actions need about the current PDF selection, or null
  // (with a Notice explaining why) when there is no usable selection.
  private getSelectionContext(): SelectionContext | null {
    const view = this.getActivePdfView();
    const file = view?.file;
    if (!view || !file) {
      new Notice("Open a PDF and select some text first.");
      return null;
    }

    const sel = activeWindow.getSelection();
    const quote = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (!sel || sel.rangeCount === 0 || quote === "") {
      new Notice("Select some text in the PDF first.");
      return null;
    }

    const range = sel.getRangeAt(0);
    const pageEl = this.closestElement(range.startContainer, ".page");
    const pageAttr = pageEl?.getAttribute("data-page-number");
    const page = pageAttr ? parseInt(pageAttr, 10) : NaN;
    if (!pageEl || Number.isNaN(page)) {
      new Notice("Could not determine the PDF page of the selection.");
      return null;
    }

    const textLayer = pageEl.querySelector(".textLayer");
    return { view, file, range, quote, page, pageEl, textLayer };
  }

  // Action 1: mark the selection — either permanent ink written into the PDF
  // file, or a screen-only overlay, depending on the marker mode setting.
  private async highlightSelection(style: MarkerStyle) {
    const ctx = this.getSelectionContext();
    if (!ctx) return;

    const pageBox = (
      ctx.pageEl.querySelector("canvas") ?? ctx.textLayer ?? ctx.pageEl
    ).getBoundingClientRect();
    const lineRects = this.mergedLineRects(ctx.range, pageBox);
    if (lineRects.length === 0) {
      new Notice("Could not measure the selection on the page.");
      return;
    }

    if (this.settings.markerMode === "overlay") {
      this.paintOverlay(ctx, style, pageBox, lineRects);
      new Notice(
        `${style === "underline" ? "Underlined" : "Highlighted"} on p. ${ctx.page} (overlay)`
      );
      return;
    }

    try {
      await this.paintMarker(
        ctx.file,
        ctx.page,
        pageBox,
        lineRects,
        ctx.quote,
        style
      );
    } catch (e) {
      console.error("PDF Highlight Notes: could not write annotation", e);
      new Notice("Could not paint into this PDF.");
      return;
    }
    new Notice(
      `${style === "underline" ? "Underlined" : "Highlighted"} on p. ${ctx.page}`
    );
    this.refreshPdfView(ctx.view, ctx.page);
  }

  // ---- Overlay marks (screen-only, no file modification) -------------------

  private paintOverlay(
    ctx: SelectionContext,
    style: MarkerStyle,
    pageBox: DOMRect,
    lineRects: DOMRect[]
  ) {
    const rects: OverlayRect[] = lineRects.map((r) => ({
      x: (r.left - pageBox.left) / pageBox.width,
      y: (r.top - pageBox.top) / pageBox.height,
      w: r.width / pageBox.width,
      h: r.height / pageBox.height,
    }));
    const mark: OverlayMark = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      page: ctx.page,
      style,
      color:
        style === "underline"
          ? this.settings.underlineColor
          : this.settings.highlightColor,
      rects,
      quote: ctx.quote.slice(0, 300),
    };
    (this.overlays[ctx.file.path] ??= []).push(mark);
    void this.saveSettings();
    this.renderOverlaysForView(ctx.view);
  }

  private renderAllOverlays() {
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      const view = leaf.view as PdfViewLike;
      this.observeView(view);
      this.renderOverlaysForView(view);
      this.injectPdfToolbar(view);
    }
  }

  // ---- Controls in the PDF viewer's top toolbar -----------------------------

  private rgbCss(rgb: readonly number[]): string {
    return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
  }

  private injectPdfToolbar(view: PdfViewLike) {
    const toolbar = view.containerEl.querySelector<HTMLElement>(".pdf-toolbar");
    if (!toolbar || toolbar.querySelector(".pdf-highlight-notes-controls"))
      return;

    const wrap = toolbar.createDiv({ cls: "pdf-highlight-notes-controls" });

    // pointerdown + preventDefault so the text selection in the PDF is still
    // alive when the action runs.
    const press = (el: HTMLElement, fn: (evt: PointerEvent) => void) => {
      el.addEventListener("pointerdown", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        fn(evt);
      });
    };

    const iconButton = (icon: string, label: string, fn: () => void) => {
      const b = wrap.createEl("button", {
        cls: "pdf-highlight-notes-tbtn clickable-icon",
        attr: { "aria-label": label },
      });
      setIcon(b, icon);
      press(b, fn);
      return b;
    };

    const colorDot = (
      label: string,
      palette: Record<string, readonly number[]>,
      get: () => string,
      set: (name: string) => void
    ) => {
      const dot = wrap.createEl("button", {
        cls: "pdf-highlight-notes-dot",
        attr: { "aria-label": label },
      });
      const refresh = () =>
        (dot.style.backgroundColor = this.rgbCss(
          palette[get()] ?? HIGHLIGHT_COLORS.yellow
        ));
      refresh();
      press(dot, (evt) => {
        const menu = new Menu();
        for (const name of Object.keys(palette)) {
          menu.addItem((item) =>
            item
              .setTitle(name)
              .setChecked(name === get())
              .onClick(() => {
                set(name);
                void this.saveSettings();
                refresh();
              })
          );
        }
        menu.showAtMouseEvent(evt);
      });
    };

    iconButton("highlighter", "Highlight selection", () =>
      void this.highlightSelection("highlight")
    );
    colorDot(
      "Highlight color",
      HIGHLIGHT_COLORS,
      () => this.settings.highlightColor,
      (n) => (this.settings.highlightColor = n as keyof typeof HIGHLIGHT_COLORS)
    );
    iconButton("underline", "Underline selection", () =>
      void this.highlightSelection("underline")
    );
    colorDot(
      "Underline color",
      UNDERLINE_COLORS,
      () => this.settings.underlineColor,
      (n) => (this.settings.underlineColor = n as keyof typeof UNDERLINE_COLORS)
    );
    iconButton("eraser", "Erase marker under selection", () =>
      void this.eraseUnderSelection()
    );
    iconButton("text-quote", "Save selection to highlights note", () =>
      void this.saveQuote()
    );
  }

  // Redraw overlays when pdf.js re-renders pages (zoom, scroll, reload).
  private observeView(view: PdfViewLike) {
    const container = view.containerEl;
    if (this.overlayObservers.has(container)) return;
    let scheduled = false;
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations caused by our own overlay elements.
      const relevant = mutations.some((m) =>
        [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)].some(
          (n) =>
            n.instanceOf(HTMLElement) &&
            !(n as HTMLElement).classList.contains(
              "pdf-highlight-notes-overlay"
            )
        )
      );
      if (!relevant || scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        this.renderOverlaysForView(view);
      });
    });
    observer.observe(container, { childList: true, subtree: true });
    this.overlayObservers.set(container, observer);
  }

  private overlayColorCss(mark: OverlayMark): string {
    const palette: Record<string, readonly number[]> =
      mark.style === "underline" ? UNDERLINE_COLORS : HIGHLIGHT_COLORS;
    const rgb = palette[mark.color] ?? HIGHLIGHT_COLORS.yellow;
    return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
  }

  private renderOverlaysForView(view: PdfViewLike) {
    const file = view.file;
    if (!file) return;
    const marks = this.overlays[file.path] ?? [];

    const pages = view.containerEl.querySelectorAll<HTMLElement>(
      ".page[data-page-number]"
    );
    pages.forEach((pageEl) => {
      pageEl
        .querySelectorAll(".pdf-highlight-notes-overlay")
        .forEach((el) => el.remove());

      const num = parseInt(pageEl.getAttribute("data-page-number") ?? "", 10);
      const pageMarks = marks.filter((m) => m.page === num);
      if (pageMarks.length === 0) return;

      // Position marks relative to the rendered canvas box, in pixels,
      // recomputed on every render pass (so zoom changes stay correct).
      const canvas = pageEl.querySelector("canvas");
      if (!canvas) return;
      const pageRect = pageEl.getBoundingClientRect();
      const box = canvas.getBoundingClientRect();
      const offX = box.left - pageRect.left;
      const offY = box.top - pageRect.top;

      for (const mark of pageMarks) {
        const color = this.overlayColorCss(mark);
        for (const r of mark.rects) {
          const div = pageEl.createDiv({
            cls: `pdf-highlight-notes-overlay pdf-highlight-notes-overlay-${mark.style}`,
          });
          div.style.left = `${offX + r.x * box.width}px`;
          div.style.top = `${offY + r.y * box.height}px`;
          div.style.width = `${r.w * box.width}px`;
          div.style.height = `${r.h * box.height}px`;
          if (mark.style === "underline") {
            div.style.borderBottomColor = color;
          } else {
            div.style.backgroundColor = color;
          }
        }
      }
    });
  }

  // Remove overlay marks intersecting the selection. Returns how many were
  // removed.
  private eraseOverlaysUnderSelection(
    ctx: SelectionContext,
    pageBox: DOMRect,
    lineRects: DOMRect[]
  ): number {
    const marks = this.overlays[ctx.file.path];
    if (!marks || marks.length === 0) return 0;

    const selBoxes = lineRects.map((r) => ({
      x1: (r.left - pageBox.left) / pageBox.width,
      x2: (r.right - pageBox.left) / pageBox.width,
      y1: (r.top - pageBox.top) / pageBox.height,
      y2: (r.bottom - pageBox.top) / pageBox.height,
    }));

    const survives = (m: OverlayMark) =>
      m.page !== ctx.page ||
      !m.rects.some((r) =>
        selBoxes.some(
          (b) => r.x < b.x2 && r.x + r.w > b.x1 && r.y < b.y2 && r.y + r.h > b.y1
        )
      );

    const kept = marks.filter(survives);
    const removed = marks.length - kept.length;
    if (removed > 0) {
      this.overlays[ctx.file.path] = kept;
      void this.saveSettings();
      this.renderOverlaysForView(ctx.view);
    }
    return removed;
  }

  // Eraser: remove any highlight/underline annotations that overlap the
  // current selection.
  private async eraseUnderSelection() {
    const ctx = this.getSelectionContext();
    if (!ctx) return;

    const pageBox = (
      ctx.pageEl.querySelector("canvas") ?? ctx.textLayer ?? ctx.pageEl
    ).getBoundingClientRect();
    const lineRects = this.mergedLineRects(ctx.range, pageBox);
    if (lineRects.length === 0) {
      new Notice("Could not measure the selection on the page.");
      return;
    }

    // Overlay marks first — erasing them needs no file access.
    const overlayRemoved = this.eraseOverlaysUnderSelection(
      ctx,
      pageBox,
      lineRects
    );

    const bytes = await this.app.vault.readBinary(ctx.file);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pdfPage = doc.getPage(ctx.page - 1);
    const { width: pw, height: ph } = pdfPage.getSize();

    // Selection bounding boxes in PDF coordinates.
    const sx = pw / pageBox.width;
    const sy = ph / pageBox.height;
    const selBoxes = lineRects.map((r) => ({
      x1: (r.left - pageBox.left) * sx,
      x2: (r.right - pageBox.left) * sx,
      y1: ph - (r.bottom - pageBox.top) * sy,
      y2: ph - (r.top - pageBox.top) * sy,
    }));

    const annots = pdfPage.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) {
      new Notice(
        overlayRemoved > 0
          ? `Erased ${overlayRemoved} marker${overlayRemoved === 1 ? "" : "s"}`
          : "No marker found under the selection."
      );
      return;
    }

    const erasable = new Set(["Highlight", "Underline"]);
    let removed = 0;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = annots.lookupMaybe(i, PDFDict);
      if (!dict) continue;
      const subtype = dict.get(PDFName.of("Subtype"));
      if (!(subtype instanceof PDFName) || !erasable.has(subtype.decodeText()))
        continue;
      const rectArr = dict.lookupMaybe(PDFName.of("Rect"), PDFArray);
      if (!rectArr || rectArr.size() < 4) continue;
      const nums: number[] = [];
      for (let k = 0; k < 4; k++) {
        const v = rectArr.lookupMaybe(k, PDFNumber);
        if (v) nums.push(v.asNumber());
      }
      if (nums.length < 4) continue;
      const ax1 = Math.min(nums[0], nums[2]);
      const ax2 = Math.max(nums[0], nums[2]);
      const ay1 = Math.min(nums[1], nums[3]);
      const ay2 = Math.max(nums[1], nums[3]);

      const overlaps = selBoxes.some(
        (b) => ax1 < b.x2 && ax2 > b.x1 && ay1 < b.y2 && ay2 > b.y1
      );
      if (overlaps) {
        annots.remove(i);
        removed++;
      }
    }

    const total = removed + overlayRemoved;
    if (total === 0) {
      new Notice("No marker found under the selection.");
      return;
    }

    // Only rewrite the file when ink annotations were actually removed.
    if (removed > 0) {
      const out = await doc.save();
      const buf = new ArrayBuffer(out.byteLength);
      new Uint8Array(buf).set(out);
      await this.app.vault.modifyBinary(ctx.file, buf);
      this.refreshPdfView(ctx.view, ctx.page);
    }

    new Notice(`Erased ${total} marker${total === 1 ? "" : "s"}`);
  }

  // Action 2: save the selection as a linked quote in the highlights note.
  // The PDF file is not touched.
  private async saveQuote() {
    const ctx = this.getSelectionContext();
    if (!ctx) return;

    // Build the same subpath Obsidian uses for "copy link to selection":
    // #page=N&selection=startIndex,startOffset,endIndex,endOffset
    let subpath = `#page=${ctx.page}`;
    if (ctx.textLayer) {
      const start = this.textLayerPosition(
        ctx.textLayer,
        ctx.range.startContainer,
        ctx.range.startOffset
      );
      const end = this.textLayerPosition(
        ctx.textLayer,
        ctx.range.endContainer,
        ctx.range.endOffset
      );
      if (start && end) {
        subpath += `&selection=${start.index},${start.offset},${end.index},${end.offset}`;
      }
    }

    const note = await this.getOrCreateHighlightsNote(ctx.file);
    const link = this.app.fileManager
      .generateMarkdownLink(ctx.file, note.path, subpath, `p. ${ctx.page}`)
      .replace(/^!/, ""); // embed marker would render the PDF inline

    const entry = [
      "",
      `> [!quote] ${link}`,
      ...ctx.quote.split("\n").map((l) => `> ${l}`),
      "",
    ].join("\n");

    await this.app.vault.append(note, entry);
    new Notice(`Quote saved to ${note.basename}`);

    if (this.settings.openNoteAfterHighlight) {
      await this.openBeside(note);
    }
  }

  // Merge the selection's client rects into one rect per text line, in
  // viewport coordinates, clipped to the page that the selection starts on.
  private mergedLineRects(range: Range, pageBox: DOMRect): DOMRect[] {
    const rects = Array.from(range.getClientRects()).filter(
      (r) =>
        r.width > 1 &&
        r.height > 1 &&
        r.left >= pageBox.left - 1 &&
        r.right <= pageBox.right + 1 &&
        r.top >= pageBox.top - 1 &&
        r.bottom <= pageBox.bottom + 1
    );
    rects.sort((a, b) => a.top - b.top || a.left - b.left);

    const lines: { top: number; bottom: number; left: number; right: number }[] =
      [];
    for (const r of rects) {
      const line = lines[lines.length - 1];
      // Same line when vertical overlap is substantial.
      if (line && r.top < line.bottom - r.height / 2) {
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
      } else {
        lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
    }
    return lines.map(
      (l) => new DOMRect(l.left, l.top, l.right - l.left, l.bottom - l.top)
    );
  }

  // Write a real Highlight/Underline annotation (with appearance stream) into
  // the PDF, so the marks persist in the file and are visible in any reader.
  private async paintMarker(
    file: TFile,
    page: number,
    pageBox: DOMRect,
    lineRects: DOMRect[],
    quote: string,
    style: MarkerStyle
  ) {
    const bytes = await this.app.vault.readBinary(file);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pdfPage = doc.getPage(page - 1);
    const { width: pw, height: ph } = pdfPage.getSize();

    // Map viewport pixels -> PDF points (origin bottom-left).
    const sx = pw / pageBox.width;
    const sy = ph / pageBox.height;
    const quads: number[][] = lineRects.map((r) => {
      const x1 = (r.left - pageBox.left) * sx;
      const x2 = (r.right - pageBox.left) * sx;
      const yTop = ph - (r.top - pageBox.top) * sy;
      const yBot = ph - (r.bottom - pageBox.top) * sy;
      // QuadPoints order: top-left, top-right, bottom-left, bottom-right.
      return [x1, yTop, x2, yTop, x1, yBot, x2, yBot];
    });

    const xs: number[] = [];
    const ys: number[] = [];
    for (const q of quads) {
      xs.push(q[0], q[2]);
      ys.push(q[1], q[5]);
    }
    const rect = [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];

    const [cr, cg, cb] =
      style === "underline"
        ? UNDERLINE_COLORS[this.settings.underlineColor]
        : HIGHLIGHT_COLORS[this.settings.highlightColor];

    // Appearance stream. Highlight: filled rectangles with Multiply blending,
    // so text stays readable under the ink. Underline: a stroked line along
    // the bottom edge of each text line.
    let ops: string;
    if (style === "underline") {
      ops = [
        `${cr} ${cg} ${cb} RG`,
        ...quads.map((q) => {
          const y = q[5] + Math.max(0.8, (q[1] - q[5]) * 0.06);
          const w = Math.max(0.8, (q[1] - q[5]) * 0.08);
          return `${w.toFixed(2)} w ${q[4].toFixed(2)} ${y.toFixed(2)} m ${q[2].toFixed(2)} ${y.toFixed(2)} l S`;
        }),
      ].join("\n");
    } else {
      ops = [
        "/G0 gs",
        `${cr} ${cg} ${cb} rg`,
        ...quads.map((q) => {
          const x = q[4];
          const y = q[5];
          const w = q[2] - q[0];
          const h = q[1] - q[5];
          return `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`;
        }),
      ].join("\n");
    }

    const appearance = doc.context.stream(ops, {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: rect,
      Resources: {
        ExtGState: { G0: { Type: "ExtGState", BM: "Multiply", CA: 1, ca: 1 } },
      },
    });
    const appearanceRef = doc.context.register(appearance);

    const annotation = doc.context.obj({
      Type: "Annot",
      Subtype: style === "underline" ? "Underline" : "Highlight",
      Rect: rect,
      QuadPoints: ([] as number[]).concat(...quads),
      C: [cr, cg, cb],
      F: 4, // print flag
      Contents: PDFString.of(quote.slice(0, 500)),
      T: PDFString.of("PDF Highlight Notes"),
      AP: { N: appearanceRef },
    });
    const annotationRef = doc.context.register(annotation);

    const existing = pdfPage.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (existing) {
      existing.push(annotationRef);
    } else {
      pdfPage.node.set(PDFName.of("Annots"), doc.context.obj([annotationRef]));
    }

    const out = await doc.save();
    // Copy into a plain ArrayBuffer for the vault API.
    const buf = new ArrayBuffer(out.byteLength);
    new Uint8Array(buf).set(out);
    await this.app.vault.modifyBinary(file, buf);
  }

  // After the file changes on disk the viewer reloads; put the reader back on
  // the page they were highlighting.
  private refreshPdfView(view: PdfViewLike, page: number) {
    window.setTimeout(() => {
      view.setEphemeralState({ subpath: `#page=${page}` });
    }, 600);
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
      .setName("Marker mode")
      .setDesc(
        "Ink: written permanently into the PDF file, visible in any reader; the viewer reloads (brief flash) on each mark. Overlay: drawn on screen only — no file change and no flash, but marks exist only inside Obsidian with this plugin enabled."
      )
      .addDropdown((dd) =>
        dd
          .addOption("ink", "Ink (permanent, in the file)")
          .addOption("overlay", "Overlay (Obsidian-only, no flash)")
          .setValue(this.plugin.settings.markerMode)
          .onChange(async (v) => {
            this.plugin.settings.markerMode = v as "ink" | "overlay";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Highlight color")
      .setDesc("Marker fill color painted into the PDF.")
      .addDropdown((dd) => {
        for (const name of Object.keys(HIGHLIGHT_COLORS)) dd.addOption(name, name);
        dd.setValue(this.plugin.settings.highlightColor).onChange(async (v) => {
          this.plugin.settings.highlightColor = v as keyof typeof HIGHLIGHT_COLORS;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Underline color")
      .setDesc("Color of underlines painted into the PDF.")
      .addDropdown((dd) => {
        for (const name of Object.keys(UNDERLINE_COLORS)) dd.addOption(name, name);
        dd.setValue(this.plugin.settings.underlineColor).onChange(async (v) => {
          this.plugin.settings.underlineColor = v as keyof typeof UNDERLINE_COLORS;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Open note after saving a quote")
      .setDesc("Open the highlights note beside the PDF after saving a quote.")
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
