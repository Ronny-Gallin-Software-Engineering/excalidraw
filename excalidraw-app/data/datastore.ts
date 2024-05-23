// private
// -----------------------------------------------------------------------------

import { SyncableExcalidrawElement } from ".";
import { ExcalidrawElement, FileId } from "../../packages/excalidraw/element/types";
import { AppState } from "../../packages/excalidraw/types";
import Portal from "../collab/Portal";
import { CouchDbClient } from "./couchdb";
import * as firebase from "./firebase";
import type { Socket } from "socket.io-client";

export const isCouch = (): boolean => {
  const url = import.meta.env.VITE_APP_COUCH_URL;

  const result = typeof url === "string" && url.length > 0;

  console.info(`is couch configurted? ${result}`);

  return result;
};
const couch = isCouch();

let couchDbClient: CouchDbClient;
if (couch) {
  couchDbClient = new CouchDbClient(import.meta.env);
}

// -----------------------------------------------------------------------------
export const loadFirebaseStorage = async (): Promise<
  typeof import("firebase/app").default
> => {
  return couch
    ? ({} as typeof import("firebase/app").default)
    : firebase.loadFirebaseStorage();
};

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  return couch
    ? couchDbClient.isSavedToFirebase(portal, elements)
    : firebase.isSavedToFirebase(portal, elements);
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  return couch
    ? couchDbClient.saveFilesToFirebase(prefix, files)
    : firebase.saveFilesToFirebase({ prefix, files });
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  return couch
    ? couchDbClient.saveToFirebase(portal, elements, appState)
    : firebase.saveToFirebase(portal, elements, appState);
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  return couch
    ? couchDbClient.loadFromFirebase(roomId, roomKey, socket)
    : firebase.loadFromFirebase(roomId, roomKey, socket);
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  return couch
    ? couchDbClient.loadFilesFromFirebase(prefix, decryptionKey, filesIds)
    : firebase.loadFilesFromFirebase(prefix, decryptionKey, filesIds);
};
