import { App, Modal, Notice } from "obsidian";
import QRCode from "qrcode";
import type { LiveCollaborationManager } from "./LiveCollaborationManager";

type LiveMode = "official" | "custom";

export class LiveCollaborationModal extends Modal {
  private manager: LiveCollaborationManager;
  private joinLink = "";
  private refreshTimer: number | null = null;

  constructor(app: App, manager: LiveCollaborationManager) {
    super(app);
    this.manager = manager;
  }

  onOpen() {
    this.modalEl.addClass("excalive-modal-frame");
    this.render();
  }

  onClose() {
    this.clearRefreshTimer();
    this.modalEl.removeClass("excalive-modal-frame");
    this.contentEl.empty();
  }

  private async render() {
    this.clearRefreshTimer();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("excalive-modal");

    this.renderHeader(contentEl);

    if (this.manager.isCollaborating()) {
      await this.renderActiveSession(contentEl);
      this.scheduleActiveRefresh();
      return;
    }

    this.renderModePicker(contentEl);
    this.renderNameField(contentEl);

    if (this.manager.getMode() === "custom") {
      this.renderCustomServerFields(contentEl);
    }

    this.renderStartSession(contentEl);
  }

  private scheduleActiveRefresh() {
    this.refreshTimer = window.setTimeout(() => {
      if (this.manager.isCollaborating()) {
        this.render();
      }
    }, 2000);
  }

  private clearRefreshTimer() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private renderHeader(contentEl: HTMLElement) {
    const header = contentEl.createDiv({ cls: "excalive-modal__header" });
    header.createDiv({
      text: "Excalive room",
      cls: "excalive-modal__eyebrow",
    });
    header.createEl("h2", {
      text: "Live collaboration",
      cls: "excalive-modal__title",
    });
    header.createEl("p", {
      text: "Start a room, scan it on iPad, and draw together with live cursors.",
      cls: "excalive-modal__subtitle",
    });
  }

  private renderModePicker(contentEl: HTMLElement) {
    const mode = this.manager.getMode();
    const panel = contentEl.createDiv({
      cls: "excalive-panel excalive-panel--mode",
    });
    this.createSectionHeading(panel, {
      title: "Room source",
      text: "Choose the link format and server before starting.",
    });
    const tabs = panel.createDiv({ cls: "excalive-mode-tabs" });

    this.createModeButton(tabs, {
      mode: "official",
      title: "Excalidraw.com",
      detail: "Official #room link and public server",
      active: mode === "official",
    });
    this.createModeButton(tabs, {
      mode: "custom",
      title: "Custom server",
      detail: "LAN or public Socket.IO endpoint",
      active: mode === "custom",
    });
  }

  private createModeButton(
    container: HTMLElement,
    options: {
      mode: LiveMode;
      title: string;
      detail: string;
      active: boolean;
    },
  ) {
    const button = container.createEl("button", {
      cls: `excalive-mode-tab${options.active ? " is-active" : ""}`,
      attr: { type: "button", "aria-pressed": String(options.active) },
    });
    button.createSpan({ cls: "excalive-mode-tab__indicator" });
    const copy = button.createSpan({ cls: "excalive-mode-tab__copy" });
    copy.createSpan({ text: options.title, cls: "excalive-mode-tab__title" });
    copy.createSpan({ text: options.detail, cls: "excalive-mode-tab__detail" });
    button.onclick = async () => {
      await this.manager.setMode(options.mode);
      await this.render();
    };
  }

  private renderNameField(contentEl: HTMLElement) {
    const panel = contentEl.createDiv({ cls: "excalive-panel" });
    this.createTextField(panel, {
      label: "Your name",
      value: this.manager.getUsername(),
      placeholder: "Obsidian",
      description: "Shown to other collaborators beside your cursor.",
      onChange: (value) => this.manager.setUsername(value),
    });
  }

  private renderCustomServerFields(contentEl: HTMLElement) {
    const card = contentEl.createDiv({
      cls: "excalive-card excalive-card--custom excalive-server-card",
    });
    this.createSectionHeading(card, {
      title: "Custom collaboration target",
      text: "Use a LAN or public endpoint. The iPad link must open a compatible Excalidraw client using the same server.",
    });

    const fields = card.createDiv({ cls: "excalive-server-fields" });
    this.createTextField(fields, {
      label: "Socket.IO server",
      value: this.manager.getServerUrl(),
      placeholder: "https://oss-collab.excalidraw.com",
      description: "Backend used by Obsidian.",
      onChange: (value) => this.manager.setServerUrl(value),
    });
    this.createTextField(fields, {
      label: "Client link base",
      value: this.manager.getClientUrl(),
      placeholder: "https://excalidraw.com",
      description: "Web client opened by QR and copy link.",
      onChange: (value) => this.manager.setClientUrl(value),
    });
  }

  private renderStartSession(contentEl: HTMLElement) {
    const sessionGrid = contentEl.createDiv({ cls: "excalive-session-grid" });
    const start = sessionGrid.createDiv({
      cls: "excalive-section excalive-section--start",
    });
    this.createSectionHeading(start, {
      title:
        this.manager.getMode() === "official"
          ? "Start a new Excalidraw.com room"
          : "Start a new custom room",
      text: "Creates a private room from the current drawing.",
    });

    const actions = start.createDiv({ cls: "excalive-actions" });
    const startButton = actions.createEl("button", {
      text: "Start new room",
      cls: "mod-cta excalive-primary-action",
      attr: { type: "button" },
    });
    startButton.onclick = async () => {
      await this.manager.startCollaboration(null);
      await this.render();
      window.setTimeout(() => this.render(), 1200);
    };

    const join = sessionGrid.createDiv({
      cls: "excalive-section excalive-section--join",
    });
    this.createSectionHeading(join, {
      title: "Join existing room",
      text: "Paste a room link and connect this drawing.",
    });
    this.createTextField(join, {
      label: "Room link",
      value: this.joinLink,
      placeholder: "https://excalidraw.com/#room=...",
      description: "Official and custom room links are accepted.",
      onChange: (value) => {
        this.joinLink = value;
      },
    });

    const joinActions = join.createDiv({ cls: "excalive-actions" });
    const joinButton = joinActions.createEl("button", {
      text: "Join room",
      attr: { type: "button" },
    });
    joinButton.onclick = async () => {
      const roomLinkData = this.manager.parseRoomLink(this.joinLink);
      if (!roomLinkData) {
        new Notice("Paste a valid Excalidraw room link first.");
        return;
      }
      await this.manager.startCollaboration(roomLinkData);
      await this.render();
      window.setTimeout(() => this.render(), 1200);
    };
  }

  private async renderActiveSession(contentEl: HTMLElement) {
    const activeRoomLink = this.manager.getActiveRoomLink() ?? "";

    const status = contentEl.createDiv({
      cls: `excalive-status ${
        this.manager.isConnected() ? "is-connected" : "is-connecting"
      }`,
    });
    status.createSpan({
      cls: `excalive-status__dot ${
        this.manager.isConnected() ? "is-connected" : "is-connecting"
      }`,
    });
    status.createSpan({
      text: this.manager.isConnected()
        ? `Connected${
            this.manager.getCollaboratorCount()
              ? ` · ${this.manager.getCollaboratorCount()} participant(s)`
              : ""
          }`
        : "Connecting to collaboration server...",
      cls: "excalive-status__text",
    });

    const linkCard = contentEl.createDiv({ cls: "excalive-card excalive-share" });
    this.createSectionHeading(linkCard, {
      title:
        this.manager.getMode() === "official"
          ? "Excalidraw.com room link"
          : "Custom room link",
      text: "Open this exact link on iPad or another browser. The room key is part of the link.",
    });

    const shareGrid = linkCard.createDiv({ cls: "excalive-share-grid" });
    const linkPanel = shareGrid.createDiv({ cls: "excalive-share-link" });
    const linkRow = linkPanel.createDiv({ cls: "excalive-link-row" });
    const input = linkRow.createEl("input", {
      value: activeRoomLink,
      attr: { readonly: "true" },
      cls: "excalive-input excalive-link-input",
    });
    input.onclick = () => input.select();
    const copyButton = linkRow.createEl("button", {
      text: "Copy link",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    copyButton.onclick = () => this.manager.copyRoomLink();
    linkPanel.createEl("p", {
      text: "The room key is embedded in this link and used for end-to-end encryption.",
      cls: "excalive-share-note",
    });

    const qrPanel = shareGrid.createDiv({ cls: "excalive-qr-panel" });
    const qrWrap = qrPanel.createDiv({ cls: "excalive-qr" });
    try {
      const qrDataUrl = await QRCode.toDataURL(activeRoomLink, {
        margin: 1,
        width: 240,
      });
      qrWrap.createEl("img", {
        attr: {
          src: qrDataUrl,
          alt: "QR code for live collaboration link",
        },
      });
    } catch (error) {
      console.error(error);
      qrWrap.setText("Could not generate QR code.");
    }

    qrPanel.createEl("p", {
      text: "Scan on iPad. If it opens a blank Excalidraw page, reload that tab once.",
      cls: "excalive-qr-caption",
    });

    const footer = contentEl.createDiv({ cls: "excalive-footer" });
    const stopButton = footer.createEl("button", {
      text: "Stop session",
      cls: "mod-warning excalive-stop-action",
      attr: { type: "button" },
    });
    stopButton.onclick = async () => {
      this.manager.stopCollaboration();
      await this.render();
    };
  }

  private createTextField(
    container: HTMLElement,
    options: {
      label: string;
      value: string;
      placeholder: string;
      description?: string;
      onChange: (value: string) => void | Promise<void>;
    },
  ) {
    const field = container.createDiv({ cls: "excalive-field" });
    field.createEl("label", {
      text: options.label,
      cls: "excalive-field__label",
    });
    const input = field.createEl("input", {
      value: options.value,
      cls: "excalive-input",
      attr: {
        type: "text",
        placeholder: options.placeholder,
      },
    });
    input.onchange = () => options.onChange(input.value);
    input.oninput = () => options.onChange(input.value);
    if (options.description) {
      field.createDiv({
        text: options.description,
        cls: "excalive-field__description",
      });
    }
    return input;
  }

  private createSectionHeading(
    container: HTMLElement,
    options: { title: string; text?: string },
  ) {
    const heading = container.createDiv({ cls: "excalive-section-heading" });
    heading.createDiv({
      text: options.title,
      cls: "excalive-section-heading__title",
    });
    if (options.text) {
      heading.createEl("p", {
        text: options.text,
        cls: "excalive-section-heading__text",
      });
    }
    return heading;
  }

}
