import {
  Activity,
  BadgeCheck,
  CircleDashed,
  FlaskConical,
  LayoutDashboard,
  Settings,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { TranslationKey } from '@/i18n/I18nProvider'

/**
 * Sidebar navigation model.
 *
 * `primary` is the working surface; `secondary` groups the review surfaces
 * (validation, history) and configuration. Counts are injected by the layout so
 * the badges reflect persisted data rather than static labels.
 *
 * Labels are translation *keys*, not strings: the navigation is a data
 * structure shared by the sidebar, the mobile drawer and the document title, so
 * resolving the key at the render site keeps a single language for all three.
 */
export interface NavItem {
  to: string
  labelKey: TranslationKey
  descriptionKey: TranslationKey
  icon: LucideIcon
  end?: boolean
  badgeKey?: 'pendingReview'
}

export const PRIMARY_NAV: NavItem[] = [
  {
    to: '/dashboard',
    labelKey: 'nav.dashboard',
    descriptionKey: 'nav.dashboardDescription',
    icon: LayoutDashboard,
    end: true,
  },
  {
    to: '/investigations',
    labelKey: 'nav.investigations',
    descriptionKey: 'nav.investigationsDescription',
    icon: FlaskConical,
  },
  {
    to: '/validation',
    labelKey: 'nav.validation',
    descriptionKey: 'nav.validationDescription',
    icon: BadgeCheck,
    badgeKey: 'pendingReview',
  },
  {
    to: '/history',
    labelKey: 'nav.history',
    descriptionKey: 'nav.historyDescription',
    icon: Activity,
  },
]

export const SECONDARY_NAV: NavItem[] = [
  {
    to: '/settings',
    labelKey: 'nav.settings',
    descriptionKey: 'nav.settingsDescription',
    icon: Settings,
  },
]

export const ICONS = {
  Sparkles,
  CircleDashed,
}
