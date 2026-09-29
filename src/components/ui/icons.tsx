import type { ReactNode, SVGProps } from "react";

/*
 * The icon inventory. Six marks, drawn for this product on a 24 px grid with a
 * 1.5 px stroke, round caps, no fill, colour from `currentColor`. Each one
 * stands for something a word cannot carry as fast: the microphone starts an
 * answer, stop ends it, the keyboard is the typed path, the page mark says
 * "this came from your pages", play and download act on a recording or a sheet.
 * Everything else in the product is a text label.
 *
 * The brand mark is not part of the six: it is the wordmark's companion.
 *
 * Adding a seventh icon needs a written reason in docs/DESIGN.md.
 */

type IconProps = { size?: number; title?: string } & Omit<SVGProps<SVGSVGElement>, "children">;

function Icon({ size = 20, title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function MicrophoneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3" />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </Icon>
  );
}

export function KeyboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </Icon>
  );
}

export function PageMarkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h4" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 5.5v13l10.5-6.5z" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4v11" />
      <path d="m7.5 11 4.5 4.5 4.5-4.5" />
      <path d="M5 20h14" />
    </Icon>
  );
}

/** The VIVA mark: a V drawn as one pen stroke, with a caret at the turn. */
export function MarkIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <rect x="1" y="1" width="22" height="22" rx="4" fill="var(--primary)" />
      <path d="M6.5 7.5 12 17l5.5-9.5" stroke="var(--on-primary)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 19.5h7" stroke="var(--correction-tint)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export const ICON_INVENTORY = ["microphone", "stop", "keyboard", "page-mark", "play", "download"] as const;
