import { Socket } from "socket.io-client";
import { SyncableExcalidrawElement } from ".";
import { hashElementsVersion } from "../../packages/excalidraw";

export interface StoredScene {
  sceneVersion: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export interface SceneWithId {
  _id: string;
  data: StoredScene;
}

export interface StoredFile {
  _id: string;
  files: Uint8Array;
}

export class SceneVersionCache {
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

export interface CouchDBError {
  error: string;
}
