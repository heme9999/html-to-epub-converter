export const SITE = {
  brandName: 'ChapterBind',
  siteTitle: 'ChapterBind',
  baseUrl: 'https://html-to-epub-converter.pages.dev',
  contactEmail: 'mayday0064@gmail.com',
  googleSiteVerification: 'wMz2VDeMwD8R6yiCgJIqFD_wM2wSzrSEauzvCtzKHyw',
  lastUpdated: '2026-11-18',
  tagline: 'Client-side HTML to EPUB 3 converter for saved web articles and multi-chapter books.',
} as const;

export interface NavLink {
  readonly href: string;
  readonly label: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { href: '/', label: 'Converter' },
  { href: '/how-to-convert-html-to-epub/', label: 'How-To Guide' },
  { href: '/html-to-epub-troubleshooting/', label: 'Troubleshooting' },
  { href: '/about/', label: 'About' },
  { href: '/privacy/', label: 'Privacy' },
  { href: '/contact/', label: 'Contact' },
];

export const FOOTER_LINKS: readonly NavLink[] = [
  { href: '/', label: 'HTML to EPUB Converter' },
  { href: '/how-to-convert-html-to-epub/', label: 'How to Convert HTML to EPUB' },
  { href: '/html-to-epub-troubleshooting/', label: 'HTML to EPUB Troubleshooting' },
  { href: '/about/', label: 'About ChapterBind' },
  { href: '/privacy/', label: 'Privacy Policy' },
  { href: '/contact/', label: 'Contact' },
];
