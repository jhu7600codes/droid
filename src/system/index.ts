// the system apps shipped in the shell image (spec section 14). order = service start order.
import type { SystemApp } from '../shell/types'
import wallpaper from './wallpaper'
import systemui from './systemui'
import launcher from './launcher'
import setupwizard from './setupwizard'

export const systemApps: SystemApp[] = [wallpaper, systemui, launcher, setupwizard]
