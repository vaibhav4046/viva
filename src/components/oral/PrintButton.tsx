"use client";
import { DownloadIcon } from "@/components/ui/icons";

/** Opens the browser's print dialog, which also saves a PDF. The print stylesheet leaves only the sheet. */
export function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return (
    <button type="button" className="btn-ghost no-print" onClick={() => window.print()}>
      <DownloadIcon size={18} />
      {label}
    </button>
  );
}
