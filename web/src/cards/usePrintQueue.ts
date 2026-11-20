import { useSyncExternalStore } from "react";
import { getPrintQueue, subscribePrintQueue, type QueueItem } from "../print-queue";

/** The print queue the Links table fills, read straight from its store (../print-queue). */
export function usePrintQueue(): readonly QueueItem[] {
  return useSyncExternalStore(subscribePrintQueue, getPrintQueue);
}
