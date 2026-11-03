// what we pull from aosp and where it goes.
// every source is a repo on the aosp github mirror, cloned shallow + sparse at TAG.
// more repos (launcher3, settings, deskclock, ...) get added here in later milestones.

export const TAG = 'android-4.4.4_r2'
// googlesource has every repo at the tag (the github mirror misses some) and supports partial clone
export const MIRROR = 'https://android.googlesource.com/'

// a stock app: only its res folder (drawables, mipmap icons, values) and license files
const app = (to, repo, res = 'res') => ({
  id: to,
  repo: 'platform/' + repo,
  paths: ['/NOTICE', '/MODULE_LICENSE_APACHE2', `/${res}/drawable*/`, `/${res}/mipmap*/`, `/${res}/values/`],
  res: [{ from: res, to: 'apps/' + to }],
  notice: 'NOTICE',
  optionalNotice: true,
})

export const sources = [
  {
    id: 'frameworks_base',
    repo: 'platform/frameworks/base',
    // sparse paths (no-cone patterns)
    paths: ['/NOTICE', '/core/res/res/drawable*/', '/core/res/res/color/', '/core/res/res/values/', '/packages/SystemUI/res/', '/packages/Keyguard/res/', '/data/fonts/'],
    res: [
      { from: 'core/res/res', to: 'framework' },
      { from: 'packages/SystemUI/res', to: 'systemui' },
      { from: 'packages/Keyguard/res', to: 'keyguard' },
    ],
    fonts: { from: 'data/fonts', pick: /^Roboto.*\.ttf$/ },
    notice: 'NOTICE',
  },
  app('launcher3', 'packages/apps/Launcher3', 'res'),
  app('settings', 'packages/apps/Settings', 'res'),
  app('deskclock', 'packages/apps/DeskClock', 'res'),
  app('calculator', 'packages/apps/Calculator', 'res'),
  app('gallery', 'packages/apps/Gallery2', 'res'),
  app('camera', 'packages/apps/Camera2', 'res'),
  app('browser', 'packages/apps/Browser', 'res'),
  app('contacts', 'packages/apps/Contacts', 'res'),
  app('music', 'packages/apps/Music', 'res'),
  app('email', 'packages/apps/Email', 'res'),
  app('calendar', 'packages/apps/Calendar', 'res'),
  app('packageinstaller', 'packages/apps/PackageInstaller', 'res'),
  app('latinime', 'packages/inputmethods/LatinIME', 'java/res'),
  app('wallpapers_basic', 'packages/wallpapers/Basic', 'res'),
]

// density buckets we ship, in dpi
export const DENSITIES = { mdpi: 160, hdpi: 240, xhdpi: 320, xxhdpi: 480 }

// names we never ship: android robot / google branded things.
// sym_def_app_icon is the robot, so is ic_launcher_android and the android boot assets.
export const EXCLUDE = [
  /^sym_def_app_icon/,
  /android_logo/i,
  /^ic_launcher_android/,
  /robot/i,
  /^ic_google/i,
  /google/i,
  /market/i, // play store icon in launcher3
  /platlogo/, // kitkat easter egg: android branding
  /_android(\.|_|$)/, // loading_tile_android and friends
]
