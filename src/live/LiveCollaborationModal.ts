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
    this.renderModePicker(contentEl);
    this.renderNameField(contentEl);

    if (this.manager.getMode() === "custom") {
      this.renderCustomServerFields(contentEl);
    } else {
      this.renderOfficialSummary(contentEl);
    }

    if (this.manager.isCollaborating()) {
      await this.renderActiveSession(contentEl);
      this.scheduleActiveRefresh();
    } else {
      this.renderStartSession(contentEl);
    }
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
    header.createEl("h2", {
      text: "Live collaboration",
      cls: "excalive-modal__title",
    });
    header.createEl("p", {
      text: "Start a room, scan the QR code on iPad, and draw together with live cursors.",
      cls: "excalive-modal__subtitle",
    });
  }

  private renderModePicker(contentEl: HTMLElement) {
    const mode = this.manager.getMode();
    const tabs = contentEl.createDiv({ cls: "excalive-mode-tabs" });

    this.createModeButton(tabs, {
      mode: "official",
      title: "Excalidraw.com",
      detail: "Use excalidraw.com/#room links",
      active: mode === "official",
    });
    this.createModeButton(tabs, {
      mode: "custom",
      title: "Custom server",
      detail: "LAN or public Socket.IO server",
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
      attr: { type: "button" },
    });
    button.createSpan({ text: options.title, cls: "excalive-mode-tab__title" });
    button.createSpan({ text: options.detail, cls: "excalive-mode-tab__detail" });
    button.onclick = async () => {
      await this.manager.setMode(options.mode);
      await this.render();
    };
  }

  private renderNameField(contentEl: HTMLElement) {
    this.createTextField(contentEl, {
      label: "Your name",
      value: this.manager.getUsername(),
      placeholder: "Obsidian",
      onChange: (value) => this.manager.setUsername(value),
    });
  }

  private renderOfficialSummary(contentEl: HTMLElement) {
    const card = contentEl.createDiv({
      cls: "excalive-card excalive-card--official",
    });
    card.createDiv({
      text: "Official room",
      cls: "excalive-card__label",
    });
    card.createEl("p", {
      text: "Creates an excalidraw.com/#room link. Scan the QR code on iPad to join the same official Excalidraw live session.",
      cls: "excalive-card__text",
    });
  }

  private renderCustomServerFields(contentEl: HTMLElement) {
    const card = contentEl.createDiv({
      cls: "excalive-card excalive-card--custom",
    });
    card.createDiv({
      text: "Custom server",
      cls: "excalive-card__label",
    });
    card.createEl("p", {
      text: "Use this for a LAN or public collaboration server. The iPad link must point to a compatible Excalidraw frontend using the same Socket.IO server.",
      cls: "excalive-card__text",
    });

    this.createTextField(card, {
      label: "Socket.IO server",
      value: this.manager.getServerUrl(),
      placeholder: "https://oss-collab.excalidraw.com",
      onChange: (value) => this.manager.setServerUrl(value),
    });
    this.createTextField(card, {
      label: "Client link base",
      value: this.manager.getClientUrl(),
      placeholder: "https://excalidraw.com",
      onChange: (value) => this.manager.setClientUrl(value),
    });
  }

  private renderStartSession(contentEl: HTMLElement) {
    const start = contentEl.createDiv({ cls: "excalive-section" });
    start.createDiv({
      text:
        this.manager.getMode() === "official"
          ? "Start an official Excalidraw.com room"
          : "Start a room on your custom server",
      cls: "excalive-section__title",
    });

    const actions = start.createDiv({ cls: "excalive-actions" });
    const startButton = actions.createEl("button", {
      text: "Start room",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    startButton.onclick = async () => {
      await this.manager.startCollaboration(null);
      await this.render();
      window.setTimeout(() => this.render(), 1200);
    };

    const join = contentEl.createDiv({ cls: "excalive-section" });
    join.createDiv({
      text: "Join an existing room",
      cls: "excalive-section__title",
    });
    this.createTextField(join, {
      label: "Room link",
      value: this.joinLink,
      placeholder: "https://excalidraw.com/#room=...",
      onChange: (value) => {
        this.joinLink = value;
      },
    });

    const joinActions = join.createDiv({ cls: "excalive-actions" });
    const joinButton = joinActions.createEl("button", {
      text: "Join pasted room",
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

    const status = contentEl.createDiv({ cls: "excalive-status" });
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

    const linkCard = contentEl.createDiv({ cls: "excalive-card" });
    linkCard.createDiv({
      text:
        this.manager.getMode() === "official"
          ? "Excalidraw.com room link"
          : "Custom room link",
      cls: "excalive-card__label",
    });

    const linkRow = linkCard.createDiv({ cls: "excalive-link-row" });
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

    const qrWrap = linkCard.createDiv({ cls: "excalive-qr" });
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

    linkCard.createEl("p", {
      text: "Scan this QR code on iPad. It must open the room link above, not a normal blank Excalidraw page.",
      cls: "excalive-card__text",
    });

    const footer = contentEl.createDiv({ cls: "excalive-footer" });
    const stopButton = footer.createEl("button", {
      text: "Stop session",
      cls: "mod-warning",
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
    return input;
  }
}
