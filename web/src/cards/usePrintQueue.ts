import { useEffect, useState } from "react";
import { PRINT_QUEUE_EVENT, type QueueItem } from "../legacy";

/**
 * The print queue the Links table keeps. The legacy code edits the array in
 * place (push/splice), so each change event takes a fresh copy for React.
 */
export function usePrintQueue(): QueueItem[] {
  const [queue, setQueue] = useState<QueueItem[]>(() => [...(window.__printQueue ?? [])]);
  useEffect(() => {
    const onChange = () => setQueue([...(window.__printQueue ?? [])]);
    window.addEventListener(PRINT_QUEUE_EVENT, onChange);
    return () => window.removeEventListener(PRINT_QUEUE_EVENT, onChange);
  }, []);
  return queue;
}
