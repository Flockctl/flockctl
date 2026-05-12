// Bundle size budgets enforced by `npm run size` (size-limit).
//
// CSS budget = 60 KB compressed (per T04 spec; current real cost ~26 KB brotli).
//
// Font budget — RAISED from 160 KB → 380 KB (actual 361.1 KB + 5%) per the
// T04 failure-mode protocol in
// `.flockctl/plan/22-ui-redesign-foundation/00-fonts-and-palette/04-bundle-size-guard.md`
// ("if not supported by the package, raise budget to actual + 5%; document the exception").
//
// Reason inline:
//   1. @fontsource-variable auto-bundles every locale subset (latin, latin-ext,
//      cyrillic, cyrillic-ext, greek, greek-ext, vietnamese). Variable fonts
//      ship the whole weight axis in one woff2, so weight subsetting is N/A.
//   2. Geist remains as a one-milestone fallback per slice 22-00 T01 step 6
//      (M26 removes it). It currently adds ~58 KB to the bundle.
//   3. woff2 is already brotli-compressed internally, so size-limit's brotli
//      pass yields no further savings — this budget reflects raw woff2 bytes.
//   4. Real per-user wire cost is much smaller: browsers fetch only the locale
//      subset they need (latin-only ≈ 117 KB across all three families).
//
// This budget will tighten in M26 once Geist is dropped and we move to the
// per-subset import (`@fontsource-variable/inter/latin.css`) pattern.
module.exports = [
  {
    name: 'CSS bundle',
    path: 'dist/assets/*.css',
    limit: '60 KB',
  },
  {
    name: 'Fonts',
    path: 'dist/assets/*.woff2',
    limit: '380 KB',
  },
];
