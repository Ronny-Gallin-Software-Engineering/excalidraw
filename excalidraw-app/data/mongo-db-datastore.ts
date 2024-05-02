import { DefaultEventsMap } from "@socket.io/component-emitter";
import { Socket } from "socket.io-client";
import { SyncableExcalidrawElement, getSyncableElements } from ".";
import {
  FileId,
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "../../packages/excalidraw/element/types";
import {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "../../packages/excalidraw/types";
import Portal from "../collab/Portal";
import { Datastore } from "./datastore";
import {
  decryptData,
  encryptData,
} from "../../packages/excalidraw/data/encryption";
import {
  MIME_TYPES,
  hashElementsVersion,
  restoreElements,
} from "../../packages/excalidraw";
import {
  RemoteExcalidrawElement,
  reconcileElements,
} from "../../packages/excalidraw/data/reconcile";
import { decompressData } from "../../packages/excalidraw/data/encode";
import PouchDB from "pouchdb";

export class MongoDBDatastore implements Datastore {
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
    console.info("saveFilesToFirebase", prefix, files);
    const erroredFiles = new Map<FileId, true>();
    const savedFiles = new Map<FileId, true>();

    await Promise.all(
      files.map(async ({ id, buffer }) => {
        try {
          await this.files.put<StoredFile>({
            _id: id,
            files: buffer,
          });
          console.info("files.put", {
            _id: id,
            files: buffer,
          });
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
    console.info("loadFilesFromFirebase", prefix, decryptionKey, filesIds);
    const loadedFiles: BinaryFileData[] = [];
    const erroredFiles = new Map<FileId, true>();

    await Promise.all(
      [...new Set(filesIds)].map(async (id) => {
        try {
          let file;
          try {
            file = await this.files.get<StoredFile>(id);
            console.info("files.get", id, file);
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
    socket: Socket<DefaultEventsMap, DefaultEventsMap> | null,
  ): Promise<SyncableExcalidrawElement[] | null> {
    console.info("loadFromFirebase", roomId, roomKey, socket);
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
    console.info("isSavedToFirebase", portal, elements);
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
    console.info("saveToFirebase", portal, elements, appState);
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
    console.info("scenes.get", docRef, storedScene);

    let resultScene: StoredScene;
    if (!storedScene) {
      const scene: StoredScene = await this.createSceneDocument(
        elements,
        roomKey,
      );
      const storedScene: SceneWithId = { _id: docRef, data: scene };
      await this.scenes.put<SceneWithId>(storedScene);
      console.info("scenes.put", storedScene);
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
      console.info("scenes.put", storedScene);
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
    console.info("createSceneDocument", elements, roomKey);
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
    console.info("encryptElements", key, elements);
    const json = JSON.stringify(elements);
    const encoded = new TextEncoder().encode(json);
    const { encryptedBuffer, iv } = await encryptData(key, encoded);
    console.info("encryptData", encryptedBuffer, iv);
    return { ciphertext: encryptedBuffer, iv };
  }

  private async decryptElements(
    data: StoredScene,
    roomKey: string,
  ): Promise<readonly ExcalidrawElement[]> {
    console.info("decryptElements", data, roomKey);

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
      console.info("scenes.get", id, scene);
      const ciphertext = this.object2Uint8array(scene.data.ciphertext);
      const iv = this.object2Uint8array(scene.data.iv);

      scene.data = {
        sceneVersion: scene.data.sceneVersion,
        iv,
        ciphertext,
      };

      console.info("getScene", id, scene);
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

interface StoredScene {
  sceneVersion: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

interface SceneWithId {
  _id: string;
  data: StoredScene;
}

interface StoredFile {
  _id: string;
  files: Uint8Array;
}

class SceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static readonly get = (socket: Socket) => {
    return SceneVersionCache.cache.get(socket);
  };
  static readonly set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, hashElementsVersion(elements));
  };
}
