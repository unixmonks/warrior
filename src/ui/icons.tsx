import type { ReactNode } from "react";

function I({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const Icon = {
  next: () => <I><path d="M4 12h12" /><path d="M12 6l6 6-6 6" /></I>,
  today: () => <I><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /><circle cx="12" cy="15" r="1.6" fill="currentColor" /></I>,
  upcoming: () => <I><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16M8 14h3M8 17h6" /></I>,
  waiting: () => <I><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></I>,
  completed: () => <I><circle cx="12" cy="12" r="8" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></I>,
  trash: () => <I><path d="M5 7h14M10 11v5M14 11v5M6 7l1 12h10l1-12M9 7V4h6v3" /></I>,
  settings: () => <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></I>,
  terminal: () => <I><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></I>,
  search: () => <I><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></I>,
  menu: () => <I><path d="M4 7h16M4 12h16M4 17h16" /></I>,
  filter: () => <I><path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" /></I>,
  plus: () => <I><path d="M12 5v14M5 12h14" /></I>,
  edit: () => <I><path d="M5 19h4L19 9l-4-4L5 15z" /><path d="M13 7l4 4" /></I>,
  sidebar: () => <I><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M9.5 5v14" /></I>,
  close: () => <I><path d="M6 6l12 12M18 6L6 18" /></I>,
  back: () => <I><path d="M15 6l-6 6 6 6" /></I>,
  sync: () => <I size={15}><path d="M20 11a8 8 0 0 0-14.3-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.5L20 16" /><path d="M20 20v-4h-4" /></I>,
  check: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  play: () => <I><path d="M7 5l12 7-12 7z" /></I>,
  pause: () => <I><path d="M8 5v14M16 5v14" /></I>,
  note: () => <I size={13}><path d="M5 4h10l4 4v12H5z" /><path d="M9 12h6M9 16h4" /></I>,
  clock: () => <I size={13}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></I>,
  repeat: () => <I size={13}><path d="M17 2l4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></I>,
  sun: () => <I><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>,
  moon: () => <I><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></I>,
};
