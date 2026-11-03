# danen store catalog

every app is a folder `store/apps/<package id>/` with:
- `listing.json`: `id`, `name`, `author`, `description`, `category` (tools, games, productivity, media, education,
  social, demo), `icon`, optional `screenshots`, `homepage`, and `dpk` (the file name of your package in the folder)
- your `.dpk`, packed with integrity hashes: `npm run pack-dpk -- your-app/ store/apps/<id>/app.dpk --integrity`
- the icon and screenshots

## publishing
1. fork the repo, add your folder, open a pull request
2. the store check action validates the manifest, sizes, permissions and every integrity hash
3. a maintainer reviews and merges; the pages build rebuilds the catalog and deploys it

each listing has a report button in the store, which opens a pre-filled github issue. listings are taken down
by removing the folder. no paid apps and no signing keys in dpk spec 0.1 (hashes only).
