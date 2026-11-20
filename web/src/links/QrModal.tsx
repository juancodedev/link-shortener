import { useEffect, useRef, useState } from "react";

/**
 * The QR modal a row's "QR code" button opens (dashboard-react T3b).
 *
 * Takes the short URL RAW and encodes it exactly once, here, because this is
 * the only place that builds the query string. A call site that encoded too
 * once shipped a QR carrying `https%3A%2F%2F…`, so scanning a sticker landed
 * nowhere. The caption is the raw URL, never a decoded one: decoding a plain
 * URL is not a no-op, it throws on a literal `%`.
 *
 * The caption and the copy button read the same `url` the image encodes, so
 * what lands on the print sheet is byte for byte what the QR carries.
 */
export function QrModal({ url, onClose }: { url: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Surfacing the failure beats a silent no-op: the owner's next move is
      // to hand-copy the code onto a sticker, where a typo is unrecoverable.
      alert("No se pudo copiar: selecciona la URL de arriba y cópiala a mano.");
    }
  }

  return (
    <div id="qr-modal" className={url === null ? "qr-modal hidden" : "qr-modal"} onClick={onClose}>
      <div className="qr-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="qr-title">Código QR</h3>
        <img
          id="qr-img"
          src={url === null ? undefined : "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(url)}
          alt="Código QR"
          className="qr-img"
        />
        <p id="qr-url" className="qr-url">
          {url}
        </p>
        <button id="copy-print-sheet" className="btn-sm btn-outline gap-top-sm" onClick={() => void copy()}>
          {copied ? "¡Copiado!" : "Copiar URL para la hoja de impresión"}
        </button>
        <button className="btn-sm gap-top-sm" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
