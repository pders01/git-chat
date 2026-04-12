import { toast } from "../components/toast.js";

// copyText copies text to clipboard and shows a toast. Pass the
// originating element so the toast event bubbles up correctly.
export async function copyText(el: HTMLElement, text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(el, `${label}: ${text.length > 40 ? text.slice(0, 37) + "…" : text}`, "success");
  } catch {
    toast(el, "Copy failed", "error");
  }
}
