import { type SyncableExcalidrawElement, getSyncableElements } from ".";
import type Portal from "../collab/Portal";
import PouchDB from "pouchdb";
import {
  type CouchDBError,
  SceneVersionCache,
  type SceneWithId,
  type StoredFile,
  type StoredScene,
} from "./couchdb.types";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "../../packages/excalidraw/element/types";
import { decompressData } from "../../packages/excalidraw/data/encode";
import { MIME_TYPES } from "../../packages/utils";
import {
  hashElementsVersion,
  reconcileElements,
  restoreElements,
} from "../../packages/excalidraw";
import {
  decryptData,
  encryptData,
} from "../../packages/excalidraw/data/encryption";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "../../packages/excalidraw/types";
import type { RemoteExcalidrawElement } from "../../packages/excalidraw/data/reconcile";
import type { Socket } from "socket.io-client";

export class CouchDbClient {
  private files: PouchDB.Database;
  private scenes: PouchDB.Database;

  constructor(env: ImportMetaEnv) {
    const ops = {
      auth: {
        username: env.VITE_APP_COUCH_USER,
        password: env.VITE_APP_COUCH_PASSWORD,
      },
    };

    this.files = new PouchDB(`${env.VITE_APP_COUCH_URL}/files`, ops);
    this.scenes = new PouchDB(`${env.VITE_APP_COUCH_URL}/scenes`, ops);
  }

  async saveFilesToFirebase(
    prefix: string,
    files: { id: FileId; buffer: Uint8Array }[],
  ): Promise<{
    savedFiles: Map<FileId, true>;
    erroredFiles: Map<FileId, true>;
  }> {
    const erroredFiles = new Map<FileId, true>();
    const savedFiles = new Map<FileId, true>();

    await Promise.all(
      files.map(async ({ id, buffer }) => {
        try {
          let storedFile: StoredFile | undefined;
          try {
            storedFile = await this.files.get<StoredFile>(id);
          } catch (e) {
            if ((e as CouchDBError).error !== "not_found") {
              throw e;
            }
          }

          if (!storedFile) {
            storedFile = {
              _id: id,
              files: buffer,
            };
          } else {
            storedFile.files = buffer;
          }

          await this.files.put<StoredFile>(storedFile);
          savedFiles.set(id, true);
        } catch (error: any) {
          erroredFiles.set(id, true);
        }
      }),
    );

    return { savedFiles, erroredFiles };
  }

  async loadFilesFromFirebase(
    prefix: string,
    decryptionKey: string,
    filesIds: readonly FileId[],
  ): Promise<{
    loadedFiles: BinaryFileData[];
    erroredFiles: Map<FileId, true>;
  }> {
    const loadedFiles: BinaryFileData[] = [];
    const erroredFiles = new Map<FileId, true>();

    await Promise.all(
      [...new Set(filesIds)].map(async (id) => {
        try {
          let file;
          try {
            file = await this.files.get<StoredFile>(id);
          } catch (e) {
            if ((e as any).error !== "not_found") {
              throw e;
            }
          }

          let arrayBuffer;
          if (file) {
            arrayBuffer = this.object2Uint8array(file.files);
          }
          if (arrayBuffer) {
            const { data, metadata } = await decompressData<BinaryFileMetadata>(
              arrayBuffer,
              { decryptionKey },
            );
            const dataURL = new TextDecoder().decode(data) as DataURL;
            loadedFiles.push({
              mimeType: metadata.mimeType || MIME_TYPES.binary,
              id,
              dataURL,
              created: metadata?.created || Date.now(),
              lastRetrieved: metadata?.created || Date.now(),
            });
          }
        } catch (e) {
          erroredFiles.set(id, true);
          console.error(e);
        }
      }),
    );

    return { loadedFiles, erroredFiles };
  }

  async loadFromFirebase(
    roomId: string,
    roomKey: string,
    socket: Socket | null,
  ): Promise<readonly SyncableExcalidrawElement[] | null> {
    const docRef = roomId;

    const storedScene = await this.getScene(docRef);

    if (!storedScene) {
      return null;
    }

    const elements = getSyncableElements(
      restoreElements(
        await this.decryptElements(storedScene.data, roomKey),
        null,
      ),
    );

    if (socket) {
      SceneVersionCache.set(socket, elements);
    }

    return elements;
  }

  isSavedToFirebase(
    portal: Portal,
    elements: readonly ExcalidrawElement[],
  ): boolean {
    if (portal.socket && portal.roomId && portal.roomKey) {
      const sceneVersion = hashElementsVersion(elements);
      return SceneVersionCache.get(portal.socket) === sceneVersion;
    }
    return true;
  }

  async saveToFirebase(
    portal: Portal,
    elements: readonly SyncableExcalidrawElement[],
    appState: AppState,
  ): Promise<SyncableExcalidrawElement[] | null> {
    const { roomId, roomKey, socket } = portal;
    if (
      // bail if no room exists as there's nothing we can do at this point
      !roomId ||
      !roomKey ||
      !socket ||
      this.isSavedToFirebase(portal, elements)
    ) {
      return null;
    }

    const docRef = roomId;

    const storedScene = await this.getScene(docRef);

    let resultScene: StoredScene;
    if (!storedScene) {
      const scene: StoredScene = await this.createSceneDocument(
        elements,
        roomKey,
      );
      const storedScene: SceneWithId = { _id: docRef, data: scene };
      await this.scenes.put<SceneWithId>(storedScene);
      resultScene = scene;
    } else {
      const prevStoredElements = getSyncableElements(
        restoreElements(
          await this.decryptElements(storedScene.data, roomKey),
          null,
        ),
      );
      const reconciledElements = getSyncableElements(
        reconcileElements(
          elements,
          prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
      resultScene = await this.createSceneDocument(reconciledElements, roomKey);

      storedScene.data = resultScene;

      this.scenes.put<SceneWithId>(storedScene);
    }

    const result = getSyncableElements(
      restoreElements(await this.decryptElements(resultScene, roomKey), null),
    );

    SceneVersionCache.set(socket, result);

    return result;
  }

  private async createSceneDocument(
    elements: readonly SyncableExcalidrawElement[],
    roomKey: string,
  ): Promise<StoredScene> {
    const sceneVersion = hashElementsVersion(elements);
    const { ciphertext, iv } = await this.encryptElements(roomKey, elements);
    return {
      sceneVersion,
      ciphertext: new Uint8Array(ciphertext),
      iv,
    } as StoredScene;
  }

  private async encryptElements(
    key: string,
    elements: readonly ExcalidrawElement[],
  ): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
    const json = JSON.stringify(elements);
    const encoded = new TextEncoder().encode(json);
    const { encryptedBuffer, iv } = await encryptData(key, encoded);
    return { ciphertext: encryptedBuffer, iv };
  }

  private async decryptElements(
    data: StoredScene,
    roomKey: string,
  ): Promise<readonly ExcalidrawElement[]> {
    const iv: Uint8Array = data.iv;
    const ciphertext = data.ciphertext;
    const decrypted = await decryptData(iv, ciphertext, roomKey);
    const decodedData = new TextDecoder("utf-8").decode(
      new Uint8Array(decrypted),
    );
    return JSON.parse(decodedData);
  }

  private async getScene(id: string): Promise<SceneWithId | null> {
    try {
      const scene = await this.scenes.get<SceneWithId>(id);
      const ciphertext = this.object2Uint8array(scene.data.ciphertext);
      const iv = this.object2Uint8array(scene.data.iv);

      scene.data = {
        sceneVersion: scene.data.sceneVersion,
        iv,
        ciphertext,
      };

      return scene;
    } catch (e) {
      if ((e as any).error !== "not_found") {
        throw e;
      } else {
        return null;
      }
    }
  }

  private object2Uint8array(source: Uint8Array) {
    const vars = Object.keys(source);
    const target = new Uint8Array(vars.length);
    for (let i = 0; i < vars.length; i++) {
      const key = Number.parseInt(vars[i]);
      target[i] = source[key];
    }
    return target;
  }
}
