export type TextRow = { y: number; x: number; tag: string; fs: number; fw: string; ff: string; tt: string; href?: string; text: string };
export type ImageCandidate = { src: string; w: number; h: number; y: number; alt: string; kind: "img" | "background" };
export type PageData = {
  title: string; finalUrl: string; pageHeight: number; metaDesc: string;
  rows: TextRow[]; imgs: ImageCandidate[]; nav: string[];
  navTop: boolean; navOverPhoto: boolean; navBg: string | null; navColor: string | null;
  logo: { src: string; w: number; h: number } | null;
  fonts: { heading: string; headingWeight: string; body: string };
  uppercaseHeadings: boolean; accent: string | null;
  buttons: { text: string; href: string; y: number }[];
  textLength: number; sample: string; dismissed: string[];
  frame: boolean; screenH: number;  // extracted in the 1440x900 iframe; height of one screen in px
};
export type Asset = { data: Buffer; mime: string };
export type Capture = {
  url: string; page: PageData; before: Asset;
  photos: (Asset & { candidate: ImageCandidate; firstScreen: boolean })[];
  logo: Asset | null;
  linkStatus: Record<string, number | "off-site" | "same-page" | "no response">;
  capturedAt: string;
};
export type FitFlag = "BOT_CHECK" | "COMING_SOON" | "TOO_LITTLE_TEXT" | "NO_PHOTO";
export type Layout = "left" | "right" | "center" | "box";
export type FirstSection = {           // mirrors skill references/content-schema.md
  photo: string; photo_focus: string; layout: Layout;
  nav_position: "top" | "bottom"; nav_style: "bar" | "over";
  nav_background?: string; nav_color?: string;
  logo_image?: string; logo_text?: string; nav_items: string[];
  heading_font: string; heading_weight?: number; body_font: string;
  uppercase_headline: boolean; eyebrow?: string;
  headline: string; subline: string; button: string; accent?: string;
};
export type Fix = { title: string; noticed: string; why: string; changes: [string, string, string] };
export type ReportContent = {
  first_name: string; website: string; goal: string;
  first_section: FirstSection;
  first_section_changes: [string, string, string];
  fixes: [Fix, Fix];
  notes_for_maggie: string;
};
export type Usage = { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
