// what we pull from aosp and where it goes.
// every source is a repo on the aosp github mirror, cloned shallow + sparse at TAG.
// more repos (launcher3, settings, deskclock, ...) get added here in later milestones.

export const TAG = 'android-4.4.4_r2'
export const MIRROR = 'https://github.com/aosp-mirror/'

export const sources = [
  {
    id: 'frameworks_base',
    repo: 'platform_frameworks_base',
    // sparse paths (no-cone patterns)
    paths: ['/NOTICE', '/core/res/res/drawable*/', '/core/res/res/color/', '/core/res/res/values/', '/packages/SystemUI/res/', '/data/fonts/'],
    res: [
      { from: 'core/res/res', to: 'framework' },
      { from: 'packages/SystemUI/res', to: 'systemui' },
    ],
    fonts: { from: 'data/fonts', pick: /^Roboto.*\.ttf$/ },
    notice: 'NOTICE',
  },
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
]
