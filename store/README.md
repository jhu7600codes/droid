# danen store catalog

every app is a folder `store/apps/<package id>/` with:
- `listing.json`: `id`, `name`, `author`, `description`, `category` (tools, games, productivity, media, education,
  social, demo), `icon`, optional `screenshots`, `homepage`, and `dpk` (the file name of your package in the folder)
- your `.dpk`, packed with integrity hashes: `npm run pack-dpk -- your-app/ store/apps/<id>/app.dpk --integrity`
- the icon and screenshots

## publishing from droid (community)
in Danen Store: menu > Publish an app (or the Publish button on the Community tab), signed in with a Danen
account. pick a `.dpk` or an Android `.apk` (converted to a dpk in the browser), give it a name, category and
description, and it is live on the Community tab. up to 50 MB; updates need a higher versioncode; a package id
belongs to whoever published it first, and ids from the main catalog (and `droid.*`) are taken. community apps
are not reviewed; 5 reports take one down. menu > My published apps lists yours and unpublishes them.
the files live in the danen backend's `droid-store` bucket (see backend/supabase/functions/danen).

## publishing to the main catalog (reviewed)
1. fork the repo, add your folder, open a pull request
2. the store check action validates the manifest, sizes, permissions and every integrity hash
3. a maintainer reviews and merges; the pages build rebuilds the catalog and deploys it

each listing has a report button in the store, which opens a pre-filled github issue. listings are taken down
by removing the folder. no paid apps and no signing keys in dpk spec 2.0 (hashes only).
