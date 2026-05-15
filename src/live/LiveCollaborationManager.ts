import { Notice } from "obsidian";
import { io, Socket } from "socket.io-client";
import { CaptureUpdateAction } from "src/constants/constants";
import type ExcalidrawView from "src/view/ExcalidrawView";
import { LiveCollaborationModal } from "./LiveCollaborationModal";
import {
  decryptData,
  encryptData,
  generateEncryptionKey,
  generateRoomId,
} from "./liveCollaborationCrypto";
import type {
  AppState,
  Collaborator,
  ExcalidrawImperativeAPI,
  Gesture,
  SocketId,
} from "@zsviczian/excalidraw/types/excalidraw/types";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@zsviczian/excalidraw/types/element/src/types";

const INITIAL_SCENE_UPDATE_TIMEOUT = 5000;
const SYNC_FULL_SCENE_INTERVAL_MS = 20000;
const CURSOR_SYNC_TIMEOUT = 33;
const DELETED_ELEMENT_TIMEOUT = 24 * 60 * 60 * 1000;
const OFFICIAL_SERVER_URL = "https://oss-collab.excalidraw.com";
const OFFICIAL_CLIENT_URL = "https://excalidraw.com";

const WS_EVENTS = {
  SERVER_VOLATILE: "server-volatile-broadcast",
  SERVER: "server-broadcast",
  USER_FOLLOW_CHANGE: "user-follow",
  USER_FOLLOW_ROOM_CHANGE: "user-follow-room-change",
} as const;

enum WS_SUBTYPES {
  INVALID_RESPONSE = "INVALID_RESPONSE",
  INIT = "SCENE_INIT",
  UPDATE = "SCENE_UPDATE",
  MOUSE_LOCATION = "MOUSE_LOCATION",
  IDLE_STATUS = "IDLE_STATUS",
  USER_VISIBLE_SCENE_BOUNDS = "USER_VISIBLE_SCENE_BOUNDS",
}

type RoomLinkData = {
  roomId: string;
  roomKey: string;
};

type LiveCollaborationMode = "official" | "custom";

type SocketUpdateDataSource = {
  INVALID_RESPONSE: {
    type: WS_SUBTYPES.INVALID_RESPONSE;
  };
  SCENE_INIT: {
    type: WS_SUBTYPES.INIT;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  SCENE_UPDATE: {
    type: WS_SUBTYPES.UPDATE;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  MOUSE_LOCATION: {
    type: WS_SUBTYPES.MOUSE_LOCATION;
    payload: {
      socketId: SocketId;
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "down" | "up";
      selectedElementIds: AppState["selectedElementIds"];
      username: string;
    };
  };
  USER_VISIBLE_SCENE_BOUNDS: {
    type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS;
    payload: {
      socketId: SocketId;
      username: string;
      sceneBounds: readonly [number, number, number, number];
    };
  };
  IDLE_STATUS: {
    type: WS_SUBTYPES.IDLE_STATUS;
    payload: {
      socketId: SocketId;
      userState: unknown;
      username: string;
    };
  };
};

type SocketUpdateData =
  SocketUpdateDataSource[keyof SocketUpdateDataSource] & {
    _brand?: "socketUpdateData";
  };

const throttle = <T extends (...args: any[]) => void>(
  fn: T,
  wait: number,
): T & { cancel: () => void } => {
  let last = 0;
  let timer: number | null = null;
  let trailingArgs: Parameters<T> | null = null;

  const run = (args: Parameters<T>) => {
    last = Date.now();
    timer = null;
    trailingArgs = null;
    fn(...args);
  };

  const throttled = ((...args: Parameters<T>) => {
    const remaining = wait - (Date.now() - last);
    if (remaining <= 0 || remaining > wait) {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      run(args);
      return;
    }
    trailingArgs = args;
    if (!timer) {
      timer = window.setTimeout(() => {
        if (trailingArgs) {
          run(trailingArgs);
        }
      }, remaining);
    }
  }) as T & { cancel: () => void };

  throttled.cancel = () => {
    if (timer) {
      window.clearTimeout(timer);
    }
    timer = null;
    trailingArgs = null;
  };

  return throttled;
};

export class LiveCollaborationManager {
  private view: ExcalidrawView;
  private socket: Socket | null = null;
  private socketInitialized = false;
  private roomId: string | null = null;
  private roomKey: string | null = null;
  private activeRoomLink: string | null = null;
  private collaborators = new Map<SocketId, Collaborator>();
  private broadcastedElementVersions: Map<string, number> = new Map();
  private lastBroadcastedOrReceivedSceneVersion = -1;
  private socketInitializationTimer: number | null = null;
  private lastPointerBroadcast = 0;

  constructor(view: ExcalidrawView) {
    this.view = view;
  }

  get api(): ExcalidrawImperativeAPI | null {
    return this.view.excalidrawAPI;
  }

  getUsername(): string {
    return this.view.plugin.settings.liveCollaborationUsername || "Obsidian";
  }

  async setUsername(username: string) {
    this.view.plugin.settings.liveCollaborationUsername = username.trim();
    await this.view.plugin.saveSettings();
  }

  getActiveRoomLink(): string | null {
    return this.activeRoomLink;
  }

  getMode(): LiveCollaborationMode {
    return this.view.plugin.settings.liveCollaborationMode ?? "official";
  }

  async setMode(mode: LiveCollaborationMode) {
    this.view.plugin.settings.liveCollaborationMode = mode;
    if (mode === "official") {
      this.view.plugin.settings.liveCollaborationServerUrl = OFFICIAL_SERVER_URL;
      this.view.plugin.settings.liveCollaborationClientUrl = OFFICIAL_CLIENT_URL;
    }
    await this.view.plugin.saveSettings();
  }

  getServerUrl(): string {
    return (
      this.view.plugin.settings.liveCollaborationServerUrl ||
      OFFICIAL_SERVER_URL
    ).replace(/\/+$/, "");
  }

  getClientUrl(): string {
    return (
      this.view.plugin.settings.liveCollaborationClientUrl ||
      OFFICIAL_CLIENT_URL
    ).replace(/\/+$/, "");
  }

  private getClientOrigin(): string | null {
    try {
      return new URL(this.getClientUrl()).origin;
    } catch {
      return null;
    }
  }

  async setServerUrl(serverUrl: string) {
    this.view.plugin.settings.liveCollaborationMode = "custom";
    this.view.plugin.settings.liveCollaborationServerUrl = serverUrl.trim();
    await this.view.plugin.saveSettings();
  }

  async setClientUrl(clientUrl: string) {
    this.view.plugin.settings.liveCollaborationMode = "custom";
    this.view.plugin.settings.liveCollaborationClientUrl = clientUrl.trim();
    await this.view.plugin.saveSettings();
  }

  isCollaborating(): boolean {
    return Boolean(this.socket && this.roomId && this.roomKey);
  }

  isConnected(): boolean {
    return Boolean(this.socket?.connected);
  }

  getCollaboratorCount(): number {
    return this.collaborators.size;
  }

  openDialog() {
    new LiveCollaborationModal(this.view.app, this).open();
  }

  renderTopRightUI(isMobile: boolean, appState: AppState) {
    const React = this.view.packages.react;

    if (!this.view.plugin.settings.liveCollaborationEnabled || !React) {
      return null;
    }

    const collaboratorCount = appState.collaborators?.size ?? 0;

    return React.createElement(
      "button",
      {
        key: "excalive-collab-trigger",
        className: `clickable-icon excalive-collab-fallback ${
          collaboratorCount > 0 ? "is-active" : ""
        }`,
        onClick: () => this.openDialog(),
        "aria-label":
          collaboratorCount > 0
            ? `Live collaboration, ${collaboratorCount} participants`
            : "Live collaboration",
        title:
          collaboratorCount > 0
            ? `Live collaboration (${collaboratorCount})`
            : "Live collaboration",
      },
      React.createElement("span", {
        className: "excalive-collab-icon",
        "aria-hidden": "true",
      }),
      collaboratorCount > 0
        ? React.createElement(
            "span",
            {
              className: "excalive-collab-badge",
              "aria-hidden": "true",
            },
            collaboratorCount,
          )
        : null,
    );
  }

  renderMainMenuItem(MainMenu: any) {
    const React = this.view.packages.react;
    if (!React || !MainMenu?.Item) {
      return null;
    }
    return React.createElement(
      MainMenu.Item,
      {
        key: "excalive-main-menu-item",
        "aria-label": "Live collaboration",
        onSelect: () => this.openDialog(),
      },
      this.isCollaborating() ? "Live collaboration active" : "Live collaboration",
    );
  }

  async startCollaboration(roomLinkData: RoomLinkData | null = null) {
    const api = this.api;
    if (!api) {
      new Notice("Excalidraw is still loading. Try again in a moment.");
      return;
    }
    if (this.socket) {
      return;
    }

    const { roomId, roomKey } =
      roomLinkData ??
      ({
        roomId: generateRoomId(),
        roomKey: await generateEncryptionKey(),
      } satisfies RoomLinkData);

    this.roomId = roomId;
    this.roomKey = roomKey;
    this.activeRoomLink = `${this.getClientUrl()}/#room=${roomId},${roomKey}`;
    this.socketInitialized = false;
    this.lastBroadcastedOrReceivedSceneVersion = this.getSceneVersion(
      this.getSceneElementsIncludingDeleted(),
    );

    try {
      this.socket = io(this.getServerUrl(), {
        transports: ["websocket"],
        ...(this.getClientOrigin()
          ? { extraHeaders: { Origin: this.getClientOrigin() } }
          : {}),
      });
      this.registerSocketListeners(roomLinkData);
      this.updateCollaboratorsScene();
      new Notice("Live collaboration started.");
    } catch (error: any) {
      this.stopCollaboration(false);
      new Notice(`Live collaboration failed: ${error?.message ?? error}`);
    }
  }

  stopCollaboration(showNotice = true, updateScene = true) {
    this.queueBroadcastAllElements.cancel();
    if (this.socketInitializationTimer) {
      window.clearTimeout(this.socketInitializationTimer);
      this.socketInitializationTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.socketInitialized = false;
    this.roomId = null;
    this.roomKey = null;
    this.activeRoomLink = null;
    this.broadcastedElementVersions.clear();
    this.collaborators = new Map();
    if (updateScene) {
      this.updateCollaboratorsScene();
    }
    if (showNotice) {
      new Notice("Live collaboration stopped.");
    }
  }

  destroy() {
    this.stopCollaboration(false, false);
  }

  async copyRoomLink() {
    if (!this.activeRoomLink) {
      return;
    }
    await navigator.clipboard.writeText(this.activeRoomLink);
    new Notice("Live collaboration link copied.");
  }

  parseRoomLink(link: string): RoomLinkData | null {
    try {
      const trimmed = link.trim();
      const url = trimmed.startsWith("#")
        ? new URL(`${this.getClientUrl()}/${trimmed}`)
        : new URL(trimmed);
      const match = url.hash.match(/^#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/);
      if (!match) {
        return null;
      }
      if (match[2].length !== 22) {
        new Notice("The room link has an invalid encryption key.");
        return null;
      }
      return { roomId: match[1], roomKey: match[2] };
    } catch {
      return null;
    }
  }

  syncElements(elements: readonly OrderedExcalidrawElement[]) {
    if (!this.isSocketReady()) {
      return;
    }
    const sceneVersion = this.getSceneVersion(elements);
    if (sceneVersion <= this.lastBroadcastedOrReceivedSceneVersion) {
      return;
    }
    this.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
    this.lastBroadcastedOrReceivedSceneVersion = sceneVersion;
    this.queueBroadcastAllElements();
  }

  onPointerUpdate(payload: {
    pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
    button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
    pointersMap: Gesture["pointers"];
  }) {
    if (!this.isSocketReady() || payload.pointersMap.size >= 2) {
      return;
    }
    const now = Date.now();
    if (now - this.lastPointerBroadcast < CURSOR_SYNC_TIMEOUT) {
      return;
    }
    this.lastPointerBroadcast = now;
    const socketId = this.socket?.id as SocketId | undefined;
    if (!socketId) {
      return;
    }
    this.broadcastSocketData(
      {
        type: WS_SUBTYPES.MOUSE_LOCATION,
        payload: {
          socketId,
          pointer: payload.pointer,
          button: payload.button || "up",
          selectedElementIds: this.api?.getAppState().selectedElementIds ?? {},
          username: this.getUsername(),
        },
      },
      true,
    );
  }

  private registerSocketListeners(roomLinkData: RoomLinkData | null) {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    socket.on("init-room", () => {
      socket.emit("join-room", this.roomId);
    });

    socket.on("new-user", () => {
      this.broadcastScene(
        WS_SUBTYPES.INIT,
        this.getSceneElementsIncludingDeleted(),
        true,
      );
    });

    socket.on("room-user-change", (clients: SocketId[]) => {
      this.setCollaborators(clients);
    });

    socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array<ArrayBuffer>) => {
        if (!this.roomKey) {
          return;
        }
        const decryptedData = await this.decryptPayload(
          iv,
          encryptedData,
          this.roomKey,
        );
        this.handleRemoteSocketData(decryptedData);
      },
    );

    socket.on("first-in-room", () => {
      this.socketInitialized = true;
    });

    socket.on(
      WS_EVENTS.USER_FOLLOW_ROOM_CHANGE,
      (followedBy: SocketId[]) => {
        this.api?.updateScene({
          appState: { followedBy: new Set(followedBy) },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      },
    );

    socket.once("connect_error", (error) => {
      new Notice(`Live collaboration socket error: ${error.message}`);
      this.socketInitialized = true;
    });

    this.socketInitializationTimer = window.setTimeout(() => {
      this.socketInitialized = true;
      if (roomLinkData) {
        new Notice("Joined room. Waiting for another client to send the scene.");
      }
    }, INITIAL_SCENE_UPDATE_TIMEOUT);
  }

  private async handleRemoteSocketData(
    decryptedData: SocketUpdateDataSource[keyof SocketUpdateDataSource],
  ) {
    switch (decryptedData.type) {
      case WS_SUBTYPES.INVALID_RESPONSE:
        return;
      case WS_SUBTYPES.INIT:
        if (!this.socketInitialized) {
          this.socketInitialized = true;
          this.clearInitializationTimer();
        }
        this.handleRemoteSceneUpdate(decryptedData.payload.elements);
        return;
      case WS_SUBTYPES.UPDATE:
        this.handleRemoteSceneUpdate(decryptedData.payload.elements);
        return;
      case WS_SUBTYPES.MOUSE_LOCATION: {
        const { pointer, button, username, selectedElementIds } =
          decryptedData.payload;
        this.updateCollaborator(decryptedData.payload.socketId, {
          pointer,
          button,
          username,
          selectedElementIds,
        });
        return;
      }
      case WS_SUBTYPES.IDLE_STATUS:
        this.updateCollaborator(decryptedData.payload.socketId, {
          username: decryptedData.payload.username,
          userState: decryptedData.payload.userState as any,
        });
        return;
      case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS:
        return;
      default:
        return;
    }
  }

  private handleRemoteSceneUpdate(
    remoteElements: readonly OrderedExcalidrawElement[],
  ) {
    const api = this.api;
    if (!api) {
      return;
    }
    const reconciledElements = this.reconcileElements(remoteElements);
    api.updateScene({
      elements: reconciledElements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  private reconcileElements(
    remoteElements: readonly OrderedExcalidrawElement[],
  ): OrderedExcalidrawElement[] {
    const api = this.api;
    const lib = this.view.packages.excalidrawLib as any;
    const localElements = this.getSceneElementsIncludingDeleted();
    const restoredRemoteElements =
      typeof lib.restoreElements === "function"
        ? lib.restoreElements(remoteElements, localElements)
        : remoteElements;
    const reconciled =
      typeof lib.reconcileElements === "function" && api
        ? lib.reconcileElements(
            localElements,
            restoredRemoteElements,
            api.getAppState(),
          )
        : restoredRemoteElements;

    this.lastBroadcastedOrReceivedSceneVersion =
      this.getSceneVersion(reconciled);
    return reconciled;
  }

  private async decryptPayload(
    iv: Uint8Array<ArrayBuffer>,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<SocketUpdateDataSource[keyof SocketUpdateDataSource]> {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);
      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      console.error(error);
      new Notice("Could not decrypt live collaboration payload.");
      return { type: WS_SUBTYPES.INVALID_RESPONSE };
    }
  }

  private async broadcastSocketData(
    data: SocketUpdateData,
    volatile = false,
    roomId?: string,
  ) {
    if (!this.isSocketReady() || !this.roomKey) {
      return;
    }
    const json = JSON.stringify(data);
    const encoded = new TextEncoder().encode(json);
    const { encryptedBuffer, iv } = await encryptData(this.roomKey, encoded);

    this.socket?.emit(
      volatile ? WS_EVENTS.SERVER_VOLATILE : WS_EVENTS.SERVER,
      roomId ?? this.roomId,
      encryptedBuffer,
      iv,
    );
  }

  private broadcastScene(
    updateType: WS_SUBTYPES.INIT | WS_SUBTYPES.UPDATE,
    elements: readonly OrderedExcalidrawElement[],
    syncAll: boolean,
  ) {
    const syncableElements = elements.reduce((acc, element) => {
      if (
        (syncAll ||
          !this.broadcastedElementVersions.has(element.id) ||
          element.version > this.broadcastedElementVersions.get(element.id)) &&
        this.isSyncableElement(element)
      ) {
        acc.push(element);
      }
      return acc;
    }, [] as OrderedExcalidrawElement[]);

    for (const syncableElement of syncableElements) {
      this.broadcastedElementVersions.set(
        syncableElement.id,
        syncableElement.version,
      );
    }

    this.broadcastSocketData({
      type: updateType,
      payload: {
        elements: syncableElements,
      },
    } as SocketUpdateData);
  }

  private queueBroadcastAllElements = throttle(() => {
    this.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.getSceneElementsIncludingDeleted(),
      true,
    );
    this.lastBroadcastedOrReceivedSceneVersion = Math.max(
      this.lastBroadcastedOrReceivedSceneVersion,
      this.getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  private isSocketReady(): boolean {
    return Boolean(
      this.socketInitialized &&
        this.socket &&
        this.socket.connected &&
        this.roomId &&
        this.roomKey,
    );
  }

  private getSceneElementsIncludingDeleted(): readonly OrderedExcalidrawElement[] {
    return (
      (this.api as any)?.getSceneElementsIncludingDeleted?.() ??
      this.api?.getSceneElements() ??
      []
    );
  }

  private getSceneVersion(elements: readonly ExcalidrawElement[]): number {
    const lib = this.view.packages.excalidrawLib as any;
    if (typeof lib.getSceneVersion === "function") {
      return lib.getSceneVersion(elements);
    }
    return elements.reduce((version, element) => version + element.version, 0);
  }

  private isSyncableElement(element: OrderedExcalidrawElement): boolean {
    if (element.isDeleted) {
      return element.updated > Date.now() - DELETED_ELEMENT_TIMEOUT;
    }
    const lib = this.view.packages.excalidrawLib as any;
    if (typeof lib.isInvisiblySmallElement === "function") {
      return !lib.isInvisiblySmallElement(element);
    }
    return true;
  }

  private setCollaborators(socketIds: SocketId[]) {
    const collaborators = new Map<SocketId, Collaborator>();
    for (const socketId of socketIds) {
      collaborators.set(socketId, {
        ...this.collaborators.get(socketId),
        isCurrentUser: socketId === this.socket?.id,
      });
    }
    this.collaborators = collaborators;
    this.updateCollaboratorsScene();
  }

  private updateCollaborator(
    socketId: SocketId,
    updates: Partial<Collaborator>,
  ) {
    const collaborators = new Map(this.collaborators);
    collaborators.set(socketId, {
      ...collaborators.get(socketId),
      ...updates,
      isCurrentUser: socketId === this.socket?.id,
    });
    this.collaborators = collaborators;
    this.updateCollaboratorsScene();
  }

  private updateCollaboratorsScene() {
    this.api?.updateScene({
      collaborators: this.collaborators,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  private clearInitializationTimer() {
    if (!this.socketInitializationTimer) {
      return;
    }
    window.clearTimeout(this.socketInitializationTimer);
    this.socketInitializationTimer = null;
  }
}

export type { RoomLinkData };
