# droid

droid 4.4 is a web imitation of android 4.4 kitkat, by danen. it runs fully in the browser (installable as a
pwa, works offline) and runs its own apps, dpks (droid packages, see [dpk-spec.md](dpk-spec.md)).

- the look is the original aosp kitkat holo assets (apache 2.0), imported by `tools/import-aosp`
- the shell is a small kernel (window manager, dpk runtime, sdk bridge); everything you see is a system app:
  launcher, systemui, settings, networks, camera, gallery, files, browser, clock, calculator, danen store,
  danen play services, package installer, setup wizard, wallpapers
- phone, tablet and desktop modes, automatic screen detection, 3 button navigation
- fake DR-Nt and VTE networks, a self-hostable proxy for the browser and apps, a danen account that works local first

## run it
```bash
npm i
npm run dev        # http://localhost:5173
npm run build      # dist/, static, deploy anywhere (github pages workflow included)
```

## make an app
see [docs/sdk.md](docs/sdk.md). a hello world is two files; `npm run pack-dpk -- folder out.dpk --integrity`,
then drop the .dpk on droid. publish it by adding it to [store/](store/README.md) with a pull request.

## more
- [docs/decisions.md](docs/decisions.md): why things are built the way they are
- [docs/hosting.md](docs/hosting.md): where the backend and the proxy can live
- [docs/arm-runtime.md](docs/arm-runtime.md): the apk conversion plan (milestone 8)
- [proxy/](proxy/README.md), [backend/](backend/README.md)

## license
droid's code is mit (LICENSE). the aosp parts are apache 2.0 (LICENSE-APACHE-2.0, NOTICE, assets/aosp/NOTICE-*).
no android robot, no google apps or branding.
