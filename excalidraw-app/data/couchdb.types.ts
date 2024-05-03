import { SyncableExcalidrawElement } from ".";
import { getSceneVersion } from "../../src/element";

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
  private static cache = new WeakMap<SocketIOClient.Socket, number>();
  static readonly get = (socket: SocketIOClient.Socket) => {
    return SceneVersionCache.cache.get(socket);
  };
  static readonly set = (
    socket: SocketIOClient.Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export interface CouchDBError {
  error: string;
}
