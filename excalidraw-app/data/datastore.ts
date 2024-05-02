import { Socket } from "socket.io-client";
import { SyncableExcalidrawElement } from ".";
import {
  ExcalidrawElement,
  FileId,
} from "../../packages/excalidraw/element/types";
import { AppState, BinaryFileData } from "../../packages/excalidraw/types";
import Portal from "../collab/Portal";

export interface Datastore {
  saveFilesToFirebase(
    prefix: string,
    files: { id: FileId; buffer: Uint8Array }[],
  ): Promise<{
    savedFiles: Map<FileId, true>;
    erroredFiles: Map<FileId, true>;
  }>;

  loadFromFirebase(
    roomId: string,
    roomKey: string,
    socket: Socket | null,
  ): Promise<SyncableExcalidrawElement[] | null>;

  isSavedToFirebase(
    portal: Portal,
    elements: readonly ExcalidrawElement[],
  ): boolean;

  saveToFirebase(
    portal: Portal,
    elements: readonly SyncableExcalidrawElement[],
    appState: AppState,
  ): Promise<SyncableExcalidrawElement[] | null>;

  loadFilesFromFirebase(
    prefix: string,
    decryptionKey: string,
    filesIds: readonly FileId[],
  ): Promise<{
    loadedFiles: BinaryFileData[];
    erroredFiles: Map<FileId, true>;
  }>;
}
