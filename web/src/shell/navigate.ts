/**
 * Page navigation, in one place so the shell's redirects can be observed in
 * tests (jsdom does not navigate).
 */
export function navigate(url: string): void {
  window.location.href = url;
}

export function reload(): void {
  window.location.reload();
}
