# decisions

## units: 1 css px = 1 dp
browsers already make 1 css px about 1/160 inch on phones, the same as a dp. so the shell is laid out
in px and they mean dp. the density bucket (mdpi..xxhdpi) only picks which images to load. fit mode
(a fixed preset scaled into the window) is a css transform on the screen element.

## holo look: generated css from aosp drawables
tools/import-aosp turns the kitkat selectors and 9-patches into one stylesheet per density.
android's "first matching state wins" is kept by putting all states inside :where() (same
specificity for every rule) and writing the items last to first.
9-patches with one stretch region per axis use css border-image. the 62 with several regions
use the canvas renderer in src/shell/ninepatch.ts.

## static assets are not bundled
assets/ is copied as-is into dist/ so the import manifest stays true and paths are stable.

## hosting
the build prompt says vercel in one place and github pages in another. going with github pages
(base './' so it also works anywhere else) until jhu says otherwise.
